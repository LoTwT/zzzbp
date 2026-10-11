import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentCatalogData,
  localLegacyCircleFileNames,
  toAgentImageUrl,
} from "../../shared/agents/catalog";
import {
  agentSquareImageUrl,
  agentThumbImageUrl,
  classificationIconImageUrl,
  isLegacyCircleImageUrl,
  localizeLegacyAgentImageUrl,
  parseAgentSquareImageUrl,
} from "../../shared/agents/assets";
import { imageAssetsManifestSchema } from "../../shared/agents/assets-schema";

/*
 * 图片资源清单与静态文件的一致性校验：清单（shared/agents/assets.json）
 * 与目录引用、public/ 下实际文件三方对齐。清单结构、来源记录与导入流程
 * 见 docs/specs/agent-data.md「图片资源清单」。
 */

/** 仓库根（测试文件位于 tests/rules/）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 清单与目录引用的对齐基线（模块顶层加载一次，测试只读）。 */
const manifest = imageAssetsManifestSchema.parse(
  JSON.parse(await readFile(resolve(ROOT, "shared/agents/assets.json"), "utf8")),
);

describe("图片资源清单与文件一致性", () => {
  it("清单修订与目录引用一致：全部代理人映射到清单资源且裁切逐条相同", () => {
    expect(manifest.revision).toBe(agentCatalogData.imageAssets?.revision);
    expect(Object.keys(manifest.agents)).toHaveLength(agentCatalogData.agents.length);
    for (const entry of agentCatalogData.agents) {
      const asset = manifest.agents[entry.iconAsset?.icon ?? ""];
      expect(asset, `清单缺少代理人 ${entry.id} 的资源 ${entry.iconAsset?.icon}`).toBeDefined();
      expect(asset.agentIds).toContain(entry.id);
      // 裁切校准值逐条一致：目录内嵌值由清单生成，两处不允许漂移。
      expect(asset.crop).toEqual(entry.iconAsset?.crop);
    }
  });

  it("分类图标映射：目录分类引用与清单一一对应", () => {
    for (const entry of agentCatalogData.elements) {
      const asset = manifest.classifications[`element-${entry.id}`];
      expect(asset, `属性 ${entry.id} 缺少图标资源`).toBeDefined();
      expect(asset.stem).toBe(entry.iconAsset);
    }
    for (const entry of agentCatalogData.specialties) {
      const asset = manifest.classifications[`specialty-${entry.id}`];
      expect(asset, `特性 ${entry.id} 缺少图标资源`).toBeDefined();
      expect(asset.stem).toBe(entry.iconAsset);
    }
    expect(Object.keys(manifest.classifications)).toHaveLength(
      agentCatalogData.elements.length + agentCatalogData.specialties.length,
    );
  });

  it("旧圆图副本覆盖全部可派生 avatarPath 的代理人", () => {
    const withAvatar = agentCatalogData.agents.filter((entry) => entry.avatarPath !== null);
    expect(withAvatar.length).toBe(55);
    for (const entry of withAvatar) {
      const url = toAgentImageUrl(entry.avatarPath);
      const fileName = url?.split("/").pop() ?? "";
      expect(manifest.legacyCircles[fileName], `旧圆图 ${fileName} 缺少本地副本`).toBeDefined();
    }
    expect(Object.keys(manifest.legacyCircles)).toHaveLength(55);
  });

  it("全部清单文件真实存在且字节数与内容哈希一致", async () => {
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const asset of Object.values(manifest.agents)) {
      files.push(asset.square, asset.thumb);
    }
    for (const asset of Object.values(manifest.classifications)) {
      files.push(asset.file);
    }
    for (const asset of Object.values(manifest.legacyCircles)) {
      files.push(asset.file);
    }
    expect(files.length).toBeGreaterThan(58 * 2);
    for (const file of files) {
      const target = resolve(ROOT, "public", `.${file.path}`);
      const info = await stat(target);
      expect(info.size, `${file.path} 字节数与清单不符`).toBe(file.bytes);
      const digest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      expect(digest, `${file.path} 内容哈希与清单不符`).toBe(file.sha256);
    }
  });

  it("方图母图为 384x384、缩略图为 128x128", () => {
    for (const asset of Object.values(manifest.agents)) {
      expect(asset.square.width).toBe(384);
      expect(asset.square.height).toBe(384);
      expect(asset.thumb.width).toBe(128);
      expect(asset.thumb.height).toBe(128);
      // 母图与缩略图同修订目录。
      expect(asset.square.path.startsWith(`/images/agents/${manifest.revision}/`)).toBe(true);
      expect(asset.thumb.path.startsWith(`/images/agents/${manifest.revision}/`)).toBe(true);
    }
  });
});

describe("图片 URL 构造与旧地址解析", () => {
  it("方图与缩略图路径构造及反向解析", () => {
    expect(agentSquareImageUrl("2026-10-09", "IconRoleCrop01")).toBe(
      "/images/agents/2026-10-09/IconRoleCrop01.webp",
    );
    expect(agentThumbImageUrl("2026-10-09", "IconRoleCrop01")).toBe(
      "/images/agents/2026-10-09/IconRoleCrop01-128.webp",
    );
    expect(classificationIconImageUrl("2026-10-09", "IconPhysical")).toBe(
      "/images/classifications/2026-10-09/IconPhysical.webp",
    );
    expect(parseAgentSquareImageUrl("/images/agents/2026-10-09/IconRoleCrop01.webp")).toEqual({
      revision: "2026-10-09",
      icon: "IconRoleCrop01",
    });
    // legacy 目录是旧圆图副本，不是方图修订。
    expect(parseAgentSquareImageUrl("/images/agents/legacy/IconRoleCircle01.webp")).toBeNull();
    expect(
      parseAgentSquareImageUrl("https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp"),
    ).toBeNull();
    expect(parseAgentSquareImageUrl("/images/agents/2026-10-09/IconRoleCrop01-128.webp")).toEqual({
      revision: "2026-10-09",
      icon: "IconRoleCrop01-128",
    });
  });

  it("非法资源段显式失败（数据已经过 schema 校验，此为编程错误防线）", () => {
    expect(() => agentSquareImageUrl("2026-10-09", "../escape")).toThrow();
    expect(() => agentThumbImageUrl("..", "IconRoleCrop01")).toThrow();
    expect(() => classificationIconImageUrl("2026-10-09", "a/b")).toThrow();
  });

  it("旧圆图收录摘要与清单一致：目录内嵌名单由清单生成，不允许漂移", () => {
    expect([...localLegacyCircleFileNames].sort()).toEqual(
      Object.keys(manifest.legacyCircles).sort(),
    );
  });

  it("旧远程圆图 URL 仅映射到已收录的本地副本；未收录或未知 URL 原样保留", () => {
    const remoteBase = "https://static.nanoka.cc/assets/zzz/";
    // 已收录的 55 张逐一覆盖：远程 URL → 同源本地副本路径。
    for (const fileName of Object.keys(manifest.legacyCircles)) {
      expect(
        localizeLegacyAgentImageUrl(`${remoteBase}${fileName}`, localLegacyCircleFileNames),
        fileName,
      ).toBe(`/images/agents/legacy/${fileName}`);
    }
    // 命名形态合法但未收录（1381/1531/1551 缺 avatarPath，其 data.icon 对应
    // 圆图编号从未收录）：不重写，按外部图片处理，不误指不存在的本地路径。
    for (const fileName of [
      "IconRoleCircle40.webp",
      "IconRoleCircle62.webp",
      "IconRoleCircle63.webp",
    ]) {
      expect(manifest.legacyCircles[fileName], `${fileName} 不应被收录`).toBeUndefined();
      expect(
        localizeLegacyAgentImageUrl(`${remoteBase}${fileName}`, localLegacyCircleFileNames),
      ).toBe(`${remoteBase}${fileName}`);
    }
    // 非 IconRoleCircleNN.webp 形态不重写，不推测新路径。
    expect(
      localizeLegacyAgentImageUrl(`${remoteBase}IconRole01.webp`, localLegacyCircleFileNames),
    ).toBe(`${remoteBase}IconRole01.webp`);
    expect(
      localizeLegacyAgentImageUrl(
        "https://example.com/IconRoleCircle01.webp",
        localLegacyCircleFileNames,
      ),
    ).toBe("https://example.com/IconRoleCircle01.webp");
    expect(isLegacyCircleImageUrl("/images/agents/legacy/IconRoleCircle01.webp")).toBe(true);
    expect(isLegacyCircleImageUrl("/images/agents/2026-10-09/IconRoleCrop01.webp")).toBe(false);
  });
});
