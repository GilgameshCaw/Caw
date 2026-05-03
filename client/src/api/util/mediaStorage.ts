import { writeFile, mkdir, rename, access, unlink } from 'fs/promises'
import path from 'path'
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { publicUrl } from './publicUrl'

export type MediaKind = 'images' | 'videos' | 'encrypted'

export interface MediaStorage {
  put(kind: MediaKind, filename: string, body: Buffer, contentType: string): Promise<string>
  putVariant(baseFilename: string, variantFilename: string, body: Buffer, contentType: string): Promise<string>
  baseExists(kind: MediaKind, filename: string): Promise<boolean>
  publicUrlFor(kind: MediaKind, filename: string): string
}

const FILEBASE_ENDPOINT = 'https://s3.filebase.io'
const FILEBASE_REGION = 'auto'

function hostnameOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

class LocalMediaStorage implements MediaStorage {
  private readonly root = path.join(process.cwd(), 'public', 'uploads')

  constructor() {
    Promise.all([
      mkdir(path.join(this.root, 'images'), { recursive: true }),
      mkdir(path.join(this.root, 'videos'), { recursive: true }),
      mkdir(path.join(this.root, 'encrypted'), { recursive: true }),
    ]).catch(console.error)
  }

  async put(kind: MediaKind, filename: string, body: Buffer): Promise<string> {
    const dest = path.join(this.root, kind, filename)
    await writeFile(dest, body)
    return this.publicUrlFor(kind, filename)
  }

  async putVariant(_baseFilename: string, variantFilename: string, body: Buffer): Promise<string> {
    const dest = path.join(this.root, 'images', variantFilename)
    await writeFile(dest, body)
    return this.publicUrlFor('images', variantFilename)
  }

  async baseExists(kind: MediaKind, filename: string): Promise<boolean> {
    try { await access(path.join(this.root, kind, filename)); return true } catch { return false }
  }

  publicUrlFor(kind: MediaKind, filename: string): string {
    return `${publicUrl()}/uploads/${kind}/${filename}`
  }
}

class FilebaseMediaStorage implements MediaStorage {
  private readonly s3: S3Client
  private readonly bucket: string
  private readonly publicUrlBase: string
  private readonly prefix: string

  constructor(accessKey: string, secret: string, bucket: string) {
    this.s3 = new S3Client({
      endpoint: FILEBASE_ENDPOINT,
      region: FILEBASE_REGION,
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
    })
    this.bucket = bucket
    // s.caw.social (or whatever) reverse-proxies /uploads/* to Filebase, so
    // the public URL keeps the same /uploads/<kind>/<filename> shape that
    // imageVariants.ts and FE renderers already understand. Old local URLs
    // (from publicUrl() + /uploads/...) keep working because they still hit
    // the API host's nginx, which still serves them off local disk.
    this.publicUrlBase = process.env.MEDIA_PUBLIC_URL_BASE || publicUrl()
    // Per-install bucket prefix so multiple CAW deployments can share one
    // bucket without key collisions and without having to scan keys to
    // attribute usage. Derived from the install's main hostname, which is
    // baked into publicUrl(). The nginx reverse-proxy injects this prefix
    // when forwarding /uploads/* to Filebase, so the public URL doesn't
    // expose it. Override with FILEBASE_KEY_PREFIX if you really need to.
    this.prefix = (process.env.FILEBASE_KEY_PREFIX || hostnameOf(publicUrl())).replace(/^\/+|\/+$/g, '')
  }

  private keyFor(kind: MediaKind, filename: string): string {
    return this.prefix ? `${this.prefix}/${kind}/${filename}` : `${kind}/${filename}`
  }

  async put(kind: MediaKind, filename: string, body: Buffer, contentType: string): Promise<string> {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(kind, filename),
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }))
    return this.publicUrlFor(kind, filename)
  }

  async putVariant(_baseFilename: string, variantFilename: string, body: Buffer, contentType: string): Promise<string> {
    return this.put('images', variantFilename, body, contentType)
  }

  async baseExists(kind: MediaKind, filename: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(kind, filename) }))
      return true
    } catch { return false }
  }

  publicUrlFor(kind: MediaKind, filename: string): string {
    return `${this.publicUrlBase}/uploads/${kind}/${filename}`
  }

  async delete(kind: MediaKind, filename: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(kind, filename) }))
  }
}

let cached: MediaStorage | null = null

export function mediaStorage(): MediaStorage {
  if (cached) return cached
  const backend = (process.env.MEDIA_STORAGE_BACKEND || 'local').toLowerCase()
  if (backend === 'filebase') {
    const accessKey = process.env.FILEBASE_ACCESS_KEY
    const secret = process.env.FILEBASE_SECRET
    const bucket = process.env.FILEBASE_BUCKET
    if (!accessKey || !secret || !bucket) {
      throw new Error('MEDIA_STORAGE_BACKEND=filebase requires FILEBASE_ACCESS_KEY, FILEBASE_SECRET, FILEBASE_BUCKET')
    }
    cached = new FilebaseMediaStorage(accessKey, secret, bucket)
  } else {
    cached = new LocalMediaStorage()
  }
  return cached
}

export async function unlinkLocalTemp(p: string): Promise<void> {
  try { await unlink(p) } catch { /* best-effort */ }
}

export async function moveLocal(src: string, dest: string): Promise<void> {
  await rename(src, dest)
}
