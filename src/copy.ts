import crypto from 'crypto'
import fs from 'fs-extra'
import ignore from 'ignore'
import npmPacklist from 'npm-packlist'
import { dirname, join } from 'path'

import { readIgnoreFile, readPackageManifest, readSignatureFile } from '.'
import {
  getStorePackagesDir,
  PackageManifest,
  writePackageManifest,
  writeSignatureFile,
} from '.'

const shortSignatureLength = 8

export const getFileHash = async (srcPath: string, relPath: string = '') => {
  const stat = await fs.lstat(srcPath)
  const md5sum = crypto.createHash('md5')
  md5sum.update(relPath.replace(/\\/g, '/'))
  if (stat.isSymbolicLink()) {
    const targetPath = await fs.readlink(srcPath)
    md5sum.update(targetPath)
    return md5sum.digest('hex')
  }
  return new Promise<string>((resolve, reject) => {
    const stream = fs.createReadStream(srcPath)
    stream.on('data', (data: string) => md5sum.update(data))
    stream.on('error', reject).on('close', () => {
      resolve(md5sum.digest('hex'))
    })
  })
}

const copyFile = async (
  srcPath: string,
  destPath: string,
  relPath: string = ''
) => {
  const stat = await fs.lstat(srcPath)
  if (stat.isSymbolicLink()) {
    const targetPath = await fs.readlink(srcPath)
    try {
      await fs.ensureDir(dirname(destPath))
      await fs.symlink(targetPath, destPath)
    } catch (e) {
      console.warn(
        `Warning: skipping copy of ${relPath}: ${(e as NodeJS.ErrnoException).message}`
      )
    }
  } else {
    await fs.copy(srcPath, destPath)
  }
  return getFileHash(srcPath, relPath)
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])

const listSymlinks = async (
  workingDir: string,
  rootPaths: string[]
): Promise<string[]> => {
  const walkDir = async (relDir: string): Promise<string[]> => {
    const fullDir = join(workingDir, relDir)
    let entries: string[]
    try {
      entries = await fs.readdir(fullDir)
    } catch (e) {
      return []
    }
    const nestedLists = await Promise.all(
      entries.map(async (entryName) => {
        if (SKIP_DIRS.has(entryName)) return []
        const childRelPath = join(relDir, entryName)
        const childPath = join(workingDir, childRelPath)
        try {
          const stat = await fs.lstat(childPath)
          if (stat.isSymbolicLink()) {
            return [childRelPath.replace(/\\/g, '/')]
          }
          if (stat.isDirectory()) {
            return walkDir(childRelPath)
          }
        } catch (e) {
          // ignore inaccessible paths
        }
        return []
      })
    )
    return nestedLists.reduce<string[]>((all, next) => all.concat(next), [])
  }

  const results: string[] = []
  for (const rootPath of rootPaths) {
    const topComponent = rootPath.split('/')[0]
    if (SKIP_DIRS.has(topComponent)) continue
    try {
      const stat = await fs.lstat(join(workingDir, rootPath))
      if (stat.isSymbolicLink()) {
        results.push(rootPath.replace(/\\/g, '/'))
      } else if (stat.isDirectory()) {
        const nested = await walkDir(rootPath)
        results.push(...nested)
      }
    } catch (e) {
      // ignore inaccessible paths
    }
  }
  return results
}

const mapObj = <T, R, K extends string>(
  obj: Record<K, T>,
  mapValue: (value: T, key: K) => R
): Record<string, R> => {
  if (Object.keys(obj).length === 0) return {}

  return Object.keys(obj).reduce<Record<string, R>>((resObj, key) => {
    if (obj[key as K]) {
      resObj[key] = mapValue(obj[key as K], key as K)
    }
    return resObj
  }, {})
}

const resolveWorkspaceDepVersion = (
  version: string,
  pkgName: string,
  workingDir: string
): string => {
  if (version !== '*' && version !== '^' && version !== '~') {
    // Regular semver specification
    return version
  }
  // Resolve workspace version aliases
  const prefix = version === '^' || version === '~' ? version : ''

  try {
    const pkgPath = require.resolve(join(pkgName, 'package.json'), {
      paths: [workingDir],
    })
    if (!pkgPath) {
    }
    const resolved = readPackageManifest(dirname(pkgPath))?.version

    return `${prefix}${resolved}` || '*'
  } catch (e) {
    console.warn('Could not resolve workspace package location for', pkgName)
    return '*'
  }
}

const resolveWorkspaces = (
  pkg: PackageManifest,
  workingDir: string
): PackageManifest => {
  const resolveDeps = (deps: PackageManifest['dependencies']) => {
    return deps
      ? mapObj(deps, (val, depPkgName) => {
          if (val.startsWith('workspace:')) {
            const version = val.split(':')[1]
            const resolved = resolveWorkspaceDepVersion(
              version,
              depPkgName,
              workingDir
            )
            console.log(
              `Resolving workspace package ${depPkgName} version ==> ${resolved}`
            )
            return resolved
          }
          return val
        })
      : deps
  }

  return {
    ...pkg,
    dependencies: resolveDeps(pkg.dependencies),
    devDependencies: resolveDeps(pkg.devDependencies),
    peerDependencies: resolveDeps(pkg.peerDependencies),
  }
}

const modPackageDev = (pkg: PackageManifest) => {
  return {
    ...pkg,
    scripts: pkg.scripts
      ? {
          ...pkg.scripts,
          prepare: undefined,
          prepublish: undefined,
        }
      : undefined,
    devDependencies: undefined,
  }
}

const fixScopedRelativeName = (path: string) => path.replace(/^\.\//, '')

export const copyPackageToStore = async (options: {
  workingDir: string
  signature?: boolean
  changed?: boolean
  content?: boolean
  devMod?: boolean
  workspaceResolve?: boolean
}): Promise<string | false> => {
  const { workingDir, devMod = true } = options
  const pkg = readPackageManifest(workingDir)

  if (!pkg) {
    throw 'Error copying package to store.'
  }
  const copyFromDir = options.workingDir
  const storePackageStoreDir = join(
    getStorePackagesDir(),
    pkg.name,
    pkg.version
  )

  const ignoreFileContent = readIgnoreFile(workingDir)

  const ignoreRule = ignore().add(ignoreFileContent)
  const npmList: string[] = await (await npmPacklist({ path: workingDir })).map(
    fixScopedRelativeName
  )

  // Scope symlink discovery to the package's files field, or fall back to
  // the top-level directories already included by npm-packlist. This prevents
  // walking into node_modules, ios/Pods, and other directories that contain
  // symlinks not intended for publishing.
  const symlinkRootPaths =
    pkg.files && pkg.files.length > 0
      ? pkg.files
      : Array.from(new Set(npmList.map((f) => f.split('/')[0])))

  const symlinkList = await listSymlinks(workingDir, symlinkRootPaths)
  const filesToCopy = Array.from(new Set(npmList.concat(symlinkList))).filter(
    (f) => !ignoreRule.ignores(f)
  )
  if (options.content) {
    console.info('Files included in published content:')
    filesToCopy.sort().forEach((f) => {
      console.log(`- ${f}`)
    })
    console.info(`Total ${filesToCopy.length} files.`)
  }
  const copyFilesToStore = async () => {
    await fs.remove(storePackageStoreDir)
    return Promise.all(
      filesToCopy
        .sort()
        .map((relPath) =>
          copyFile(
            join(copyFromDir, relPath),
            join(storePackageStoreDir, relPath),
            relPath
          )
        )
    )
  }
  const hashes = options.changed
    ? await Promise.all(
        filesToCopy
          .sort()
          .map((relPath) => getFileHash(join(copyFromDir, relPath), relPath))
      )
    : await copyFilesToStore()

  const signature = crypto
    .createHash('md5')
    .update(hashes.join(''))
    .digest('hex')

  if (options.changed) {
    const publishedSig = readSignatureFile(storePackageStoreDir)
    if (signature === publishedSig) {
      return false
    } else {
      await copyFilesToStore()
    }
  }

  writeSignatureFile(storePackageStoreDir, signature)
  const versionPre = options.signature
    ? '+' + signature.substr(0, shortSignatureLength)
    : ''

  const resolveDeps = (pkg: PackageManifest): PackageManifest =>
    options.workspaceResolve ? resolveWorkspaces(pkg, workingDir) : pkg

  const pkgToWrite: PackageManifest = {
    ...resolveDeps(devMod ? modPackageDev(pkg) : pkg),
    yalcSig: signature,
    version: pkg.version + versionPre,
  }
  writePackageManifest(storePackageStoreDir, pkgToWrite)
  return signature
}
