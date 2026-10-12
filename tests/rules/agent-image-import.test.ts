import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { planImportWrite } from "../../shared/agents/assets-import";
import {
  imageAssetsManifestSchema,
  type AgentImageAsset,
  type AssetFile,
  type ImageAssetsManifest,
} from "../../shared/agents/assets-schema";

/*
 * 图片资源导入批次校验（shared/agents/assets-import.ts）的规则测试。
 *
 * 覆盖不可变资源约定的关键分支：同修订幂等重跑、同修订任何变化（内容/
 * 裁切/新增/移除）拒绝、新修订写入与旧资源保留、legacy 收录只增不改、
 * 磁盘与清单的冲突（覆盖拒绝、缺失与漂移）。磁盘状态经注入读取器模拟，
 * 不改真实资源、不依赖网络；脚本回归只在临时副本中执行（导入流程见
 * docs/specs/agent-data.md「图片资源导入流程」）。
 */

/** 64 位十六进制内容哈希的替身（仅用于区分内容，不代表真实图片）。 */
function sha(seed: string): string {
  return seed.padEnd(64, ".");
}

function fileOf(path: string, seed: string): AssetFile {
  return { path, bytes: 100, sha256: sha(seed), width: 10, height: 10 };
}

/** 最小可用的方图资源记录（路径与修订目录耦合由 schema 校验）。 */
function agentAsset(revision: string, stem: string, seed: string): AgentImageAsset {
  return {
    agentIds: ["1011"],
    sourceUrl: `https://static.nanoka.cc/assets/zzz/${stem}.webp`,
    crop: { x: 50, y: 41 },
    square: fileOf(`/images/agents/${revision}/${stem}.webp`, `${seed}-sq`),
    thumb: fileOf(`/images/agents/${revision}/${stem}-128.webp`, `${seed}-th`),
  };
}

/** 构造一份通过 schema 的最小清单（1 方图、1 分类图标、2 旧圆图）。 */
function manifestOf(revision: string): ImageAssetsManifest {
  return imageAssetsManifestSchema.parse({
    revision,
    agents: { IconRoleCrop01: agentAsset(revision, "IconRoleCrop01", "a1") },
    classifications: {
      "element-200": {
        stem: "IconPhysical",
        sourceUrl: "https://static.nanoka.cc/assets/zzz/IconPhysical.webp",
        file: fileOf(`/images/classifications/${revision}/IconPhysical.webp`, "c1"),
      },
    },
    legacyCircles: {
      "IconRoleCircle01.webp": {
        sourceUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp",
        file: fileOf("/images/agents/legacy/IconRoleCircle01.webp", "l1"),
      },
      "IconRoleCircle05.webp": {
        sourceUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle05.webp",
        file: fileOf("/images/agents/legacy/IconRoleCircle05.webp", "l5"),
      },
    },
  });
}

/** 由清单推导「全部文件已存在且内容一致」的模拟磁盘。 */
function diskOf(manifest: ImageAssetsManifest): Map<string, string> {
  const disk = new Map<string, string>();
  for (const asset of Object.values(manifest.agents)) {
    disk.set(asset.square.path, asset.square.sha256);
    disk.set(asset.thumb.path, asset.thumb.sha256);
  }
  for (const asset of Object.values(manifest.classifications)) {
    disk.set(asset.file.path, asset.file.sha256);
  }
  for (const asset of Object.values(manifest.legacyCircles)) {
    disk.set(asset.file.path, asset.file.sha256);
  }
  return disk;
}

/** 模拟磁盘读取器（path → 哈希；未收录返回 null 即文件不存在）。 */
function readerOf(disk: Map<string, string>) {
  return async (path: string): Promise<string | null> => disk.get(path) ?? null;
}

/** 计划写入集合：清单中除沿用记录外的全部文件。 */
function writePathsOf(manifest: ImageAssetsManifest, carried: ReadonlySet<string>): Set<string> {
  const paths = new Set<string>();
  for (const asset of Object.values(manifest.agents)) {
    paths.add(asset.square.path);
    paths.add(asset.thumb.path);
  }
  for (const asset of Object.values(manifest.classifications)) paths.add(asset.file.path);
  for (const asset of Object.values(manifest.legacyCircles)) {
    if (!carried.has(asset.file.path)) paths.add(asset.file.path);
  }
  return paths;
}

/** 沿用记录的路径集合（已收录的 legacy 副本不重新写入）。 */
const carriedLegacyPaths = new Set([
  "/images/agents/legacy/IconRoleCircle01.webp",
  "/images/agents/legacy/IconRoleCircle05.webp",
]);

describe("导入批次校验", () => {
  it("同内容重复导入：全部幂等跳过，不产生任何写入", async () => {
    const manifest = manifestOf("2026-10-09");
    const plan = await planImportWrite({
      plannedManifest: manifest,
      plannedWritePaths: writePathsOf(manifest, carriedLegacyPaths),
      existingManifest: manifest,
      readDiskSha256: readerOf(diskOf(manifest)),
    });
    expect(plan.writes).toEqual([]);
    expect(plan.unchanged).toHaveLength(5);
    expect(new Set(plan.unchanged)).toEqual(
      new Set([...diskOf(manifest).keys()].sort((left, right) => left.localeCompare(right))),
    );
  });

  it("同修订母图内容变化：拒绝，提示必须使用新修订", async () => {
    const existing = manifestOf("2026-10-09");
    const planned = manifestOf("2026-10-09");
    planned.agents.IconRoleCrop01 = agentAsset("2026-10-09", "IconRoleCrop01", "changed");
    await expect(
      planImportWrite({
        plannedManifest: planned,
        plannedWritePaths: writePathsOf(planned, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(diskOf(existing)),
      }),
    ).rejects.toThrow(/必须使用新的 --revision/);
  });

  it("同修订裁切校准变化：拒绝", async () => {
    const existing = manifestOf("2026-10-09");
    const planned = manifestOf("2026-10-09");
    planned.agents.IconRoleCrop01.crop = { x: 50, y: 99 };
    await expect(
      planImportWrite({
        plannedManifest: planned,
        plannedWritePaths: writePathsOf(planned, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(diskOf(existing)),
      }),
    ).rejects.toThrow(/裁切校准变化|记录不同/);
  });

  it("同修订新增条目：拒绝（新增也是变化，需新修订）", async () => {
    const existing = manifestOf("2026-10-09");
    const planned = manifestOf("2026-10-09");
    planned.agents.IconRoleCrop05 = agentAsset("2026-10-09", "IconRoleCrop05", "a5");
    await expect(
      planImportWrite({
        plannedManifest: planned,
        plannedWritePaths: writePathsOf(planned, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(diskOf(existing)),
      }),
    ).rejects.toThrow(/新增条目.*必须使用新的 --revision/);
  });

  it("新修订：版本资源写入新目录，沿用与新增 legacy 均不改写旧文件", async () => {
    const existing = manifestOf("2026-10-09");
    const planned = manifestOf("2026-10-10");
    // 新修订补收录一张旧圆图（IconRoleCircle05 已在 existing，再新增 09）。
    planned.legacyCircles["IconRoleCircle09.webp"] = {
      sourceUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle09.webp",
      file: fileOf("/images/agents/legacy/IconRoleCircle09.webp", "l9"),
    };
    const disk = diskOf(existing); // 新文件（新修订目录与 09）尚不存在
    const plan = await planImportWrite({
      plannedManifest: planned,
      plannedWritePaths: writePathsOf(planned, carriedLegacyPaths),
      existingManifest: existing,
      readDiskSha256: readerOf(disk),
    });
    // 写入 = 新修订的方图/缩略图/分类图标 + 新收录的旧圆图；旧修订文件
    // 不在计划内，磁盘上原样保留。
    expect([...plan.writes].sort()).toEqual(
      [
        "/images/agents/2026-10-10/IconRoleCrop01-128.webp",
        "/images/agents/2026-10-10/IconRoleCrop01.webp",
        "/images/classifications/2026-10-10/IconPhysical.webp",
        "/images/agents/legacy/IconRoleCircle09.webp",
      ].sort(),
    );
    expect(plan.unchanged).toEqual([
      "/images/agents/legacy/IconRoleCircle01.webp",
      "/images/agents/legacy/IconRoleCircle05.webp",
    ]);
  });

  it("新收录旧圆图的路径上已有不同内容：拒绝覆盖，保留原文件", async () => {
    const existing = manifestOf("2026-10-09");
    const planned = manifestOf("2026-10-10");
    planned.legacyCircles["IconRoleCircle09.webp"] = {
      sourceUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle09.webp",
      file: fileOf("/images/agents/legacy/IconRoleCircle09.webp", "l9"),
    };
    const disk = diskOf(existing);
    // 磁盘上已有同路径的不同内容（历史残留），不允许静默覆盖。
    disk.set("/images/agents/legacy/IconRoleCircle09.webp", sha("stray"));
    await expect(
      planImportWrite({
        plannedManifest: planned,
        plannedWritePaths: writePathsOf(planned, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(disk),
      }),
    ).rejects.toThrow(/已有不同内容.*必须使用新的 --revision/);
  });

  it("已收录 legacy 记录被改动或缺失：拒绝（收录只增不改）", async () => {
    const existing = manifestOf("2026-10-09");
    const changed = manifestOf("2026-10-10");
    changed.legacyCircles["IconRoleCircle01.webp"] = {
      sourceUrl: "https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp",
      file: fileOf("/images/agents/legacy/IconRoleCircle01.webp", "rewritten"),
    };
    await expect(
      planImportWrite({
        plannedManifest: changed,
        plannedWritePaths: writePathsOf(changed, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(diskOf(changed)),
      }),
    ).rejects.toThrow(/收录记录被改动/);

    const dropped = manifestOf("2026-10-10");
    delete dropped.legacyCircles["IconRoleCircle05.webp"];
    await expect(
      planImportWrite({
        plannedManifest: dropped,
        plannedWritePaths: writePathsOf(dropped, carriedLegacyPaths),
        existingManifest: existing,
        readDiskSha256: readerOf(diskOf(dropped)),
      }),
    ).rejects.toThrow(/收录记录被改动/);
  });

  it("沿用记录引用的 legacy 文件在磁盘上缺失或漂移：拒绝", async () => {
    const manifest = manifestOf("2026-10-09");
    const missing = diskOf(manifest);
    missing.delete("/images/agents/legacy/IconRoleCircle01.webp");
    await expect(
      planImportWrite({
        plannedManifest: manifest,
        plannedWritePaths: writePathsOf(manifest, carriedLegacyPaths),
        existingManifest: manifest,
        readDiskSha256: readerOf(missing),
      }),
    ).rejects.toThrow(/磁盘上不存在且不在本次写入计划内/);

    const drifted = diskOf(manifest);
    drifted.set("/images/agents/legacy/IconRoleCircle05.webp", sha("drift"));
    await expect(
      planImportWrite({
        plannedManifest: manifest,
        plannedWritePaths: writePathsOf(manifest, carriedLegacyPaths),
        existingManifest: manifest,
        readDiskSha256: readerOf(drifted),
      }),
    ).rejects.toThrow(/磁盘内容与清单记录不符/);
  });

  it("计划写入未被清单引用的路径：拒绝（编排防线）", async () => {
    const manifest = manifestOf("2026-10-09");
    const stray = new Set(writePathsOf(manifest, carriedLegacyPaths));
    stray.add("/images/agents/2026-10-09/Stray.webp");
    await expect(
      planImportWrite({
        plannedManifest: manifest,
        plannedWritePaths: stray,
        existingManifest: manifest,
        readDiskSha256: readerOf(diskOf(manifest)),
      }),
    ).rejects.toThrow(/未被清单引用/);
  });
});

it("导入目标被目录占用时，整批预检失败且不写入图片或清单", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const fixture = await mkdtemp(join(tmpdir(), "zzzbp-image-import-"));
  try {
    await mkdir(join(fixture, "scripts"));
    await Promise.all([
      cp(
        join(root, "scripts/import-image-assets.ts"),
        join(fixture, "scripts/import-image-assets.ts"),
      ),
      cp(join(root, "shared"), join(fixture, "shared"), { recursive: true }),
      cp(join(root, "public"), join(fixture, "public"), { recursive: true }),
      cp(join(root, "package.json"), join(fixture, "package.json")),
      symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir"),
    ]);
    const manifestPath = join(fixture, "shared/agents/assets.json");
    const before = await readFile(manifestPath, "utf8");
    const manifest = imageAssetsManifestSchema.parse(JSON.parse(before));
    const sources = join(fixture, "sources");
    await mkdir(sources);
    const sourceFiles = [
      ...Object.values(manifest.agents).map((asset) => asset.square.path),
      ...Object.values(manifest.classifications).map((asset) => asset.file.path),
    ];
    for (const path of sourceFiles) {
      await cp(join(fixture, "public", path), join(sources, basename(path)));
    }

    const revision = "test-preflight";
    const classifications = join(fixture, "public/images/classifications", revision);
    // 让冲突排在方图之后：若预检误吞读取错误，会先写入大量新图片才失败。
    // 超时按「重编码 58 张母图 + 整批预检」的真实耗时留足余量（母图自
    // 2026-10-12-coldload 起为 sharp 固定参数有损重编码，不再是字节复制）。
    await mkdir(join(classifications, "IconWind.webp"), { recursive: true });
    await expect(
      promisify(execFile)(
        process.execPath,
        ["scripts/import-image-assets.ts", "--sources", sources, "--revision", revision],
        { cwd: fixture, timeout: 180_000 },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(readdir(join(fixture, "public/images/agents", revision))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(classifications)).toEqual(["IconWind.webp"]);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 240_000);
