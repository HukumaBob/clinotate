/** True while the segment a point/box click asks for is still being computed:
 * the predict request is going out, or a predict job (either model) is queued
 * or running. Track must wait for it -- it used to be enabled as soon as a
 * prompt existed, so a track job queued right behind the predict job and the
 * predict's draft mask was left behind, never replaced by the tracked one. */
export function isSegmentPending(
  predictRequestPending: boolean,
  job: { job_type: string; status: string } | null | undefined,
): boolean {
  if (predictRequestPending) return true;
  if (!job || !job.job_type.endsWith("_predict")) return false;
  return job.status === "pending" || job.status === "running";
}
