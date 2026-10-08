import { useEffect } from "react";

const DRIFT_SECONDS = 0.15;

/** Makes `follower` mirror `master`: play, pause, seeks, and a correction
 * when playback drifts apart. The follower is muted so only one audio track
 * plays. */
export function useSyncedVideos(
  masterRef: React.RefObject<HTMLVideoElement | null>,
  followerRef: React.RefObject<HTMLVideoElement | null>,
): void {
  useEffect(() => {
    const master = masterRef.current;
    const follower = followerRef.current;
    if (!master || !follower) return;
    follower.muted = true;

    const copyTime = () => {
      follower.currentTime = master.currentTime;
    };
    const onPlay = () => void follower.play();
    const onPause = () => {
      follower.pause();
      copyTime();
    };
    const onTimeUpdate = () => {
      if (Math.abs(follower.currentTime - master.currentTime) > DRIFT_SECONDS) copyTime();
    };

    master.addEventListener("seeked", copyTime);
    master.addEventListener("play", onPlay);
    master.addEventListener("pause", onPause);
    master.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      master.removeEventListener("seeked", copyTime);
      master.removeEventListener("play", onPlay);
      master.removeEventListener("pause", onPause);
      master.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [masterRef, followerRef]);
}
