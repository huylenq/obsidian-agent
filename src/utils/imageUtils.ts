import { ImageAttachment } from "@/types";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Convert a Blob (from clipboard, drag-drop, or OS file picker) to ImageAttachment.
 */
export function blobToImageAttachment(blob: Blob, name?: string): Promise<ImageAttachment> {
  if (blob.size > MAX_IMAGE_SIZE) {
    return Promise.reject(new Error(`Image too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB (max 5MB)`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // dataUrl format: "data:image/png;base64,iVBOR..."
      const commaIndex = dataUrl.indexOf(",");
      const meta = dataUrl.slice(0, commaIndex); // "data:image/png;base64"
      const data = dataUrl.slice(commaIndex + 1);
      const mediaType = meta.split(":")[1].split(";")[0];
      resolve({ data, mediaType, name });
    };
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
}
