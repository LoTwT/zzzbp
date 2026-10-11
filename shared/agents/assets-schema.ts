import { z } from "zod";
import { imageAssetNameSchema, imageCropSchema } from "./schema.ts";

/*
 * 图片资源清单（shared/agents/assets.json）的共享 schema。
 *
 * 清单是导入脚本（scripts/import-image-assets.ts）的产物、目录生成脚本
 * （scripts/generate-agent-catalog.ts）的输入，并接受测试校验
 * （tests/rules/agent-image-assets.test.ts）；只在 Node 脚本与测试中使用，
 * 不进入任何运行时 bundle。运行时只需要 shared/agents/assets.ts 的路径
 * 构造与旧地址解析。数据事实与来源见 docs/specs/agent-data.md。
 */

/** 单个资源文件的可校验事实：公开路径、字节数、内容哈希与像素尺寸。 */
export const assetFileSchema = z.object({
  /** 同源根路径引用（不含域名，部署在任意同源环境下稳定）。 */
  path: z.string().startsWith("/").endsWith(".webp"),
  bytes: z.number().int().positive(),
  sha256: z.string().length(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AssetFile = z.infer<typeof assetFileSchema>;

/** 代理人方图资源：母图、缩略图与宽幅裁切校准值。 */
export const agentImageAssetSchema = z.object({
  /** 使用该资源的代理人稳定 ID（与目录条目对应）。 */
  agentIds: z.array(z.string().min(1)).min(1),
  /** 上游来源 URL（Nanoka 静态资源）。 */
  sourceUrl: z.string().url(),
  /** 宽幅裁切的 object-position 百分比（看图校准，随修订不可变）。 */
  crop: imageCropSchema,
  /** 384x384 方图母图（池内方图与选用区宽幅裁切共用）。 */
  square: assetFileSchema,
  /** 128x128 缩略图（顶部禁用区，64 CSS px 在 2x 屏幕的清晰度）。 */
  thumb: assetFileSchema,
});
export type AgentImageAsset = z.infer<typeof agentImageAssetSchema>;

/** 分类（属性/特性）图标资源。 */
export const classificationImageAssetSchema = z.object({
  stem: imageAssetNameSchema,
  sourceUrl: z.string().url(),
  file: assetFileSchema,
});
export type ClassificationImageAsset = z.infer<typeof classificationImageAssetSchema>;

/** 旧圆图本地副本（对应旧目录 avatarPath 派生的远程 URL）。 */
export const legacyCircleImageAssetSchema = z.object({
  sourceUrl: z.string().url(),
  file: assetFileSchema,
});
export type LegacyCircleImageAsset = z.infer<typeof legacyCircleImageAssetSchema>;

/**
 * 图片资源清单：固定修订下全部图片文件的事实记录。
 *
 * 修订标识与目录中的 imageAssets.revision 对应；更新图片或裁切校准时
 * 产生新修订并在 public/images/ 下新增版本目录，旧修订目录与 legacy
 * 副本保留（live 房间与归档可能长期引用）。
 */
export const imageAssetsManifestSchema = z
  .object({
    /** 资源修订标识（目录经 imageAssets.revision 引用）。 */
    revision: imageAssetNameSchema,
    /** 代理人方图资源，按主干名索引。 */
    agents: z.record(z.string(), agentImageAssetSchema),
    /** 分类图标资源，按「element-<id>」/「specialty-<id>」索引。 */
    classifications: z.record(z.string(), classificationImageAssetSchema),
    /** 旧圆图本地副本，按原文件名索引。 */
    legacyCircles: z.record(z.string(), legacyCircleImageAssetSchema),
  })
  .superRefine((manifest, ctx) => {
    // 代理人方图的公开路径必须落在自身修订目录内，缩略图与母图同主干。
    for (const [stem, asset] of Object.entries(manifest.agents)) {
      if (asset.square.path !== `/images/agents/${manifest.revision}/${stem}.webp`) {
        ctx.addIssue({
          code: "custom",
          message: `代理人资源 ${stem} 的母图路径与修订目录不符：${asset.square.path}`,
          path: ["agents", stem, "square", "path"],
          input: asset.square.path,
        });
      }
      if (asset.thumb.path !== `/images/agents/${manifest.revision}/${stem}-128.webp`) {
        ctx.addIssue({
          code: "custom",
          message: `代理人资源 ${stem} 的缩略图路径与修订目录不符：${asset.thumb.path}`,
          path: ["agents", stem, "thumb", "path"],
          input: asset.thumb.path,
        });
      }
      if (asset.square.width !== asset.square.height || asset.thumb.width !== asset.thumb.height) {
        ctx.addIssue({
          code: "custom",
          message: `代理人资源 ${stem} 的母图/缩略图应为正方形`,
          path: ["agents", stem],
          input: asset,
        });
      }
    }
    for (const [key, asset] of Object.entries(manifest.classifications)) {
      if (asset.file.path !== `/images/classifications/${manifest.revision}/${asset.stem}.webp`) {
        ctx.addIssue({
          code: "custom",
          message: `分类资源 ${key} 的路径与修订目录不符：${asset.file.path}`,
          path: ["classifications", key, "file", "path"],
          input: asset.file.path,
        });
      }
    }
    for (const [fileName, asset] of Object.entries(manifest.legacyCircles)) {
      if (asset.file.path !== `/images/agents/legacy/${fileName}`) {
        ctx.addIssue({
          code: "custom",
          message: `旧圆图 ${fileName} 的本地副本路径不符：${asset.file.path}`,
          path: ["legacyCircles", fileName, "file", "path"],
          input: asset.file.path,
        });
      }
    }
  });
export type ImageAssetsManifest = z.infer<typeof imageAssetsManifestSchema>;
