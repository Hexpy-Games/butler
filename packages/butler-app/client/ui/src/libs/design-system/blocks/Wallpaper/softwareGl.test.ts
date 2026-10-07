// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { isSoftwareWallpaperRenderer } from "./softwareGl";

test("software rasterizers are recognised; GPUs and unknown renderers are not", () => {
  for (const name of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
    "Google SwiftShader",
  ]) expect(isSoftwareWallpaperRenderer(name)).toBe(true);
  for (const name of ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)", "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11)", "", "WebKit WebGL"]) {
    expect(isSoftwareWallpaperRenderer(name)).toBe(false);
  }
});
