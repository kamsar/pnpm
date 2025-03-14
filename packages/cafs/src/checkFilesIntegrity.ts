import { promises as fs } from 'fs'
import { DeferredManifestPromise, PackageFileInfo } from '@pnpm/fetcher-base'
import gfs from '@pnpm/graceful-fs'
import rimraf from '@zkochan/rimraf'
import pLimit from 'p-limit'
import ssri from 'ssri'
import { getFilePathByModeInCafs } from './getFilePathInCafs'
import { parseJsonBuffer } from './parseJson'

const limit = pLimit(20)
const MAX_BULK_SIZE = 1 * 1024 * 1024 // 1MB

export interface PackageFilesIndex {
  // name and version are nullable for backward compatibility
  // the initial specs of pnpm store v3 did not require these fields.
  // However, it might be possible that some types of dependencies don't
  // have the name/version fields, like the local tarball dependencies.
  name?: string
  version?: string

  files: Record<string, PackageFileInfo>
  sideEffects?: Record<string, Record<string, PackageFileInfo>>
}

export default async function (
  cafsDir: string,
  pkgIndex: Record<string, PackageFileInfo>,
  manifest?: DeferredManifestPromise
) {
  let verified = true
  await Promise.all(
    Object.keys(pkgIndex)
      .map(async (f) =>
        limit(async () => {
          const fstat = pkgIndex[f]
          if (!fstat.integrity) {
            throw new Error(`Integrity checksum is missing for ${f}`)
          }
          if (
            !await verifyFile(
              getFilePathByModeInCafs(cafsDir, fstat.integrity, fstat.mode),
              fstat,
              f === 'package.json' ? manifest : undefined
            )
          ) {
            verified = false
          }
        })
      )
  )
  return verified
}

type FileInfo = Pick<PackageFileInfo, 'size' | 'checkedAt'> & {
  integrity: string | ssri.IntegrityLike
}

async function verifyFile (
  filename: string,
  fstat: FileInfo,
  deferredManifest?: DeferredManifestPromise
) {
  const currentFile = await checkFile(filename, fstat.checkedAt)
  if (currentFile == null) return false
  if (currentFile.isModified) {
    if (currentFile.size !== fstat.size) {
      await rimraf(filename)
      return false
    }
    return verifyFileIntegrity(filename, fstat, deferredManifest)
  }
  if (deferredManifest != null) {
    parseJsonBuffer(await gfs.readFile(filename), deferredManifest)
  }
  // If a file was not edited, we are skipping integrity check.
  // We assume that nobody will manually remove a file in the store and create a new one.
  return true
}

export async function verifyFileIntegrity (
  filename: string,
  expectedFile: FileInfo,
  deferredManifest?: DeferredManifestPromise
) {
  try {
    if (expectedFile.size > MAX_BULK_SIZE && (deferredManifest == null)) {
      const ok = Boolean(await ssri.checkStream(gfs.createReadStream(filename), expectedFile.integrity))
      if (!ok) {
        await rimraf(filename)
      }
      return ok
    }
    const data = await gfs.readFile(filename)
    const ok = Boolean(ssri.checkData(data, expectedFile.integrity))
    if (!ok) {
      await rimraf(filename)
    } else if (deferredManifest != null) {
      parseJsonBuffer(data, deferredManifest)
    }
    return ok
  } catch (err: any) { // eslint-disable-line
    switch (err.code) {
    case 'ENOENT': return false
    case 'EINTEGRITY': {
      // Broken files are removed from the store
      await rimraf(filename)
      return false
    }
    }
    throw err
  }
}

async function checkFile (filename: string, checkedAt?: number) {
  try {
    const { mtimeMs, size } = await fs.stat(filename)
    return {
      isModified: (mtimeMs - (checkedAt ?? 0)) > 100,
      size,
    }
  } catch (err: any) { // eslint-disable-line
    if (err.code === 'ENOENT') return null
    throw err
  }
}
