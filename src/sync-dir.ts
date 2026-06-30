import glob from 'glob'
import util from 'util'
import { dirname, resolve } from 'path'
import fs from 'fs-extra'
import { getFileHash } from './copy'

const NODE_MAJOR_VERSION = parseInt(
  (<any>process).versions.node.split('.').shift(),
  10
)

if (NODE_MAJOR_VERSION >= 8 && NODE_MAJOR_VERSION < 10) {
  // Symbol.asyncIterator polyfill for Node 8 + 9
  ;(Symbol as any).asyncIterator =
    Symbol.asyncIterator || Symbol('Symbol.asyncIterator')
}

const globP = util.promisify(glob)

const cache: {
  [dir: string]: {
    glob: string[]
    files: {
      [file: string]: { stat: fs.Stats; hash: string }
    }
  }
} = {}

const makeListMap = (list: string[]) => {
  return list.reduce((map, item) => {
    map[item] = true
    return map
  }, {} as { [file: string]: true })
}

const theSameStats = (srcStat: fs.Stats, destStat: fs.Stats) => {
  return (
    srcStat.mtime.getTime() === destStat.mtime.getTime() &&
    srcStat.size === destStat.size
  )
}

const copySymlink = async (srcPath: string, destPath: string) => {
  const target = await fs.readlink(srcPath)
  await fs.ensureDir(dirname(destPath))
  try {
    await fs.remove(destPath)
  } catch (e) {
    // ignore
  }
  await fs.symlink(target, destPath)
}

export const copyDirSafe = async (
  srcDir: string,
  destDir: string,
  compareContent = true
) => {
  const ignore = '**/node_modules/**'
  const dot = true
  const nodir = false
  const srcList = cache[srcDir]
    ? cache[srcDir].glob
    : await globP('**', { cwd: srcDir, ignore, dot, nodir })
  const destList = await globP('**', { cwd: destDir, ignore, dot, nodir })
  const srcMap = makeListMap(srcList)
  const destMap = makeListMap(destList)

  const newFiles = srcList.filter((file) => !destMap[file])
  const filesToRemove = destList.filter((file) => !srcMap[file])
  const commonFiles = srcList.filter((file) => destMap[file])
  cache[srcDir] = cache[srcDir] || {
    files: {},
    glob: srcList,
  }
  const filesToReplace: string[] = []
  const srcCached = cache[srcDir].files

  const dirsInDest: { [file: string]: boolean } = {}

  for await (const file of commonFiles) {
    srcCached[file] = srcCached[file] || {}
    const srcFilePath = resolve(srcDir, file)
    const destFilePath = resolve(destDir, file)
    const srcFileStat = srcCached[file].stat || (await fs.lstat(srcFilePath))
    srcCached[file].stat = srcFileStat
    let destFileStat: fs.Stats
    try {
      destFileStat = await fs.lstat(destFilePath)
    } catch (e) {
      // dest entry inaccessible (dangling), treat as new
      filesToReplace.push(file)
      continue
    }

    const srcIsSymlink = srcFileStat.isSymbolicLink()
    const destIsSymlink = destFileStat.isSymbolicLink()

    // If src is a symlink, check if dest matches
    if (srcIsSymlink) {
      if (destIsSymlink) {
        const srcTarget = await fs.readlink(srcFilePath)
        const destTarget = await fs.readlink(destFilePath)
        if (srcTarget !== destTarget) {
          filesToReplace.push(file)
        }
      } else {
        filesToReplace.push(file)
      }
      continue
    }

    const areDirs = srcFileStat.isDirectory() && destFileStat.isDirectory()
    dirsInDest[file] = destFileStat.isDirectory() && !destIsSymlink

    const replacedFileWithDir =
      srcFileStat.isDirectory() && !destFileStat.isDirectory()
    const dirReplacedWithFile =
      !srcFileStat.isDirectory() && destFileStat.isDirectory()
    if (dirReplacedWithFile || replacedFileWithDir) {
      filesToRemove.push(file)
    }

    const compareByHash = async () => {
      const srcHash =
        srcCached[file].hash || (await getFileHash(srcFilePath, ''))
      srcCached[file].hash = srcHash
      const destHash = await getFileHash(destFilePath, '')
      return srcHash === destHash
    }
    if (
      dirReplacedWithFile ||
      (!areDirs &&
        !theSameStats(srcFileStat, destFileStat) &&
        (!compareContent || !(await compareByHash())))
    ) {
      filesToReplace.push(file)
    }
  }

  // first remove files
  await Promise.all(
    filesToRemove
      .filter((file) => !dirsInDest[file])
      .map((file) => fs.remove(resolve(destDir, file)))
  )
  // then empty directories
  await Promise.all(
    filesToRemove
      .filter((file) => dirsInDest[file])
      .map((file) => fs.remove(resolve(destDir, file)))
  )

  const newFileTypes = await Promise.all(
    newFiles.map(async (file) => {
      const stat = await fs.lstat(resolve(srcDir, file))
      return { isDir: stat.isDirectory(), isSymlink: stat.isSymbolicLink() }
    })
  )

  // Copy symlinks from new files
  await Promise.all(
    newFiles
      .filter((_file, index) => newFileTypes[index].isSymlink)
      .map((file) => copySymlink(resolve(srcDir, file), resolve(destDir, file)))
  )

  // Copy regular files (not dirs, not symlinks)
  await Promise.all(
    newFiles
      .filter(
        (_file, index) =>
          !newFileTypes[index].isDir && !newFileTypes[index].isSymlink
      )
      .map((file) => fs.copy(resolve(srcDir, file), resolve(destDir, file)))
  )

  // Handle replacements: could be symlinks or regular files
  await Promise.all(
    filesToReplace.map(async (file) => {
      const srcPath = resolve(srcDir, file)
      const destPath = resolve(destDir, file)
      const stat = await fs.lstat(srcPath)
      if (stat.isSymbolicLink()) {
        await copySymlink(srcPath, destPath)
      } else {
        await fs.copy(srcPath, destPath)
      }
    })
  )
}
