import { ZERO_CROP, type Crop } from "./CropFields";

/** The crop of the newest sequence (highest id), or no crop at all. */
export function mostRecentCrop(sequences: { id: number; crop_box?: unknown }[]): Crop {
  const mostRecent = [...sequences].sort((a, b) => b.id - a.id)[0];
  return (mostRecent?.crop_box as Crop | null | undefined) ?? ZERO_CROP;
}
