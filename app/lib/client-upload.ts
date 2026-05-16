// ============================================================
// Browser-side direct-to-Cloudinary upload helper.
// Used by the artist dashboard to bypass Vercel's 4.5 MB body
// limit. Flow:
//   1. POST /api/upload-signature → get a signed payload
//   2. POST FormData to Cloudinary's upload endpoint
//   3. Return the resulting secure_url
// ============================================================

export type UploadProgress = (percent: number) => void;

export async function uploadDirectToCloudinary(opts: {
  file: File;
  folder: string;
  publicId: string;
  resourceType?: 'raw' | 'image';
  onProgress?: UploadProgress;
}): Promise<string> {
  // ----- 1. Mint a signature from our server -----
  const sigRes = await fetch('/api/upload-signature', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folder: opts.folder,
      public_id: opts.publicId,
      resource_type: opts.resourceType || 'raw',
    }),
  });
  if (!sigRes.ok) {
    const err = await sigRes.json().catch(() => ({}));
    throw new Error(err.error || 'Could not get upload signature.');
  }
  const sig: {
    signature: string;
    timestamp: number;
    api_key: string;
    cloud_name: string;
    folder: string;
    public_id: string;
    resource_type: string;
  } = await sigRes.json();

  // ----- 2. Build the upload URL -----
  const endpoint = `https://api.cloudinary.com/v1_1/${sig.cloud_name}/${sig.resource_type}/upload`;

  // ----- 3. POST the file -----
  // We use XMLHttpRequest (not fetch) so we can report progress.
  return new Promise<string>((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', opts.file);
    fd.append('api_key', sig.api_key);
    fd.append('timestamp', String(sig.timestamp));
    fd.append('signature', sig.signature);
    fd.append('folder', sig.folder);
    fd.append('public_id', sig.public_id);
    fd.append('overwrite', 'true');
    fd.append('use_filename', 'false');
    fd.append('unique_filename', 'false');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.secure_url as string);
        } catch {
          reject(new Error('Bad response from Cloudinary.'));
        }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (data?.error?.message) msg = data.error.message;
        } catch {
          // ignore
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(fd);
  });
}
