import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useSyncedVideos } from "./useSyncedVideos";

function video() {
  const el = document.createElement("video");
  el.play = vi.fn().mockResolvedValue(undefined);
  el.pause = vi.fn();
  return el;
}

function setup() {
  const master = video();
  const follower = video();
  renderHook(() => useSyncedVideos({ current: master }, { current: follower }));
  return { master, follower };
}

it("mirrors play, pause and seeks, and mutes the follower", () => {
  const { master, follower } = setup();
  expect(follower.muted).toBe(true);
  master.currentTime = 3;
  master.dispatchEvent(new Event("seeked"));
  expect(follower.currentTime).toBe(3);
  master.dispatchEvent(new Event("play"));
  expect(follower.play).toHaveBeenCalled();
  master.currentTime = 4;
  master.dispatchEvent(new Event("pause"));
  expect(follower.pause).toHaveBeenCalled();
  expect(follower.currentTime).toBe(4);
});

it("corrects drift only beyond the tolerance", () => {
  const { master, follower } = setup();
  master.currentTime = 10;
  follower.currentTime = 10.1;
  master.dispatchEvent(new Event("timeupdate"));
  expect(follower.currentTime).toBe(10.1);
  follower.currentTime = 11;
  master.dispatchEvent(new Event("timeupdate"));
  expect(follower.currentTime).toBe(10);
});
