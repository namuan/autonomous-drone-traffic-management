import { expect, it } from "vitest";
import * as THREE from "three";
import { cameraYawForFpv, fpvDirection, fpvRight } from "./math.js";

it("camera forward + screen-right match the FPV math (empirical)", () => {
  for (const [yaw, pitch] of [
    [0, 0],
    [Math.PI, 0],
    [Math.PI / 2, 0.3],
    [-1.2, -0.4],
    [3, 1.1],
    [-3, 0],
  ]) {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    cam.rotation.order = "YXZ";
    cam.rotation.y = cameraYawForFpv(yaw);
    cam.rotation.x = pitch;
    cam.updateMatrixWorld(true);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const want = fpvDirection(yaw, pitch);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const wantRight = fpvRight(yaw);
    expect(Math.hypot(fwd.x - want.x, fwd.y - want.y, fwd.z - want.z)).toBeLessThan(1e-9);
    expect(Math.hypot(right.x - wantRight.x, right.y - wantRight.y, right.z - wantRight.z)).toBeLessThan(1e-9);
  }
});
