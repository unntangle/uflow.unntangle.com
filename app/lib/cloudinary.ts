// ============================================================
// Cloudinary helpers (server-side only)
// ============================================================
// We organise uploads by client/project/revision:
//
//   officemate/jupiter/uploads/rev-1/source.zip
//   officemate/jupiter/uploads/rev-1/glb/Jupiter.glb
//   officemate/jupiter/uploads/rev-1/fbx/Jupiter.fbx
//   officemate/jupiter/uploads/rev-1/gltf/scene.gltf
//   officemate/jupiter/feedback/rev-1/<uuid>.png
//   officemate/jupiter/approved/Jupiter.glb     ← public, served by officemate.unntangle.com
//
// All uploads use resource_type:'raw' for non-image assets
// (glb/fbx/gltf/zip) because Cloudinary treats them as
// arbitrary binary files. Feedback images use the default
// resource_type:'image'.
// ============================================================

import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

let configured = false;

function configure() {
  if (configured) return;

  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
    process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error(
      'Missing Cloudinary env vars. See app/crm/SETUP.md.'
    );
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });

  configured = true;
}

// ============================================================
// Upload a binary Buffer to Cloudinary using the streaming API.
// We use upload_stream because the standard upload() needs a
// file path on disk, which doesn't work on Vercel serverless.
// ============================================================
export function uploadBuffer(
  buffer: Buffer,
  options: {
    folder: string;
    publicId: string;
    resourceType: 'image' | 'raw' | 'video' | 'auto';
  }
): Promise<UploadApiResponse> {
  configure();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        public_id: options.publicId,
        resource_type: options.resourceType,
        overwrite: true,
        // Don't auto-classify — we set the extension manually
        // via public_id so .glb URLs end in .glb, not .bin.
        use_filename: false,
        unique_filename: false,
      },
      (err, result) => {
        if (err) return reject(err);
        if (!result) return reject(new Error('Cloudinary returned no result'));
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

// ============================================================
// Folder helpers — single source of truth for path layout.
// ============================================================
export function uploadFolder(
  clientSlug: string,
  projectSlug: string,
  revision: number
): string {
  return `${clientSlug}/${projectSlug}/uploads/rev-${revision}`;
}

export function feedbackFolder(
  clientSlug: string,
  projectSlug: string,
  revision: number
): string {
  return `${clientSlug}/${projectSlug}/feedback/rev-${revision}`;
}

export function approvedFolder(
  clientSlug: string,
  projectSlug: string
): string {
  return `${clientSlug}/${projectSlug}/approved`;
}
