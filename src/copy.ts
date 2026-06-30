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
    await fs.ensureDir(dirname(destPath))
    await fs.symlink(targetPath, destPath)
  } else {
    await fs.copy(srcPath, destPath)
  }
  return getFileHash(srcPath, relPath)
}

const SKIP_DIRS = new Set(['node_modules', '.git'])

const listSymlinks = async (
  workingDir: string,
  rootPaths: string[]
): Promise<string[]> => {
  const walk = async (relDir: string): Promise<string[]> => {
    let entries: string[]
    try {
      entries = await fs.readdir(join(workingDir, relDir))
    } catch {
      return []
    }
    const lists = await Promise.all(
      entries.map(async (name) => {
        if (SKIP_DIRS.has(name)) return []
        const rel = join(relDir, name).replace(/\\/g, '/')
        try {
          const s = await fs.lstat(join(workingDir, rel))
          if (s.isSymbolicLink()) return [rel]
          if (s.isDirectory()) return walk(rel)
        } catch {
          /* skip inaccessible */
        }
        return []
      })
    )
    return lists.reduce<string[]>((a, b) => a.concat(b), [])
  }

  const results: string[] = []
  for (const root of rootPaths) {
    if (SKIP_DIRS.has(root.split('/')[0])) continue
    try {
      const s = await fs.lstat(join(workingDir, root))
      if (s.isSymbolicLink()) results.push(root.replace(/\\/g, '/'))
      else if (s.isDirectory()) results.push(...(await walk(root)))
    } catch {
      /* skip */
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

  // Discover symlinks that npm-packlist may have excluded, scoped to
  // the package's files field or existing top-level directories.
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
