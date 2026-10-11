import { calculationDataVersion } from "@randomplay/data";
import { describe, expect, it } from "vitest";
import { BP_STEP_COUNT, BP_STEP_ORDER } from "../../shared/bp/steps";
import { projectArchiveSnapshot } from "../../shared/contracts/records";
import { versionInfoSchema, type VersionInfo } from "../../shared/contracts/versions";
import {
  agentCatalogData,
  agentDataVersion,
  toAgentCatalog,
  toAgentDisplayLookup,
  toAgentImageUrl,
} from "../../shared/agents/catalog";
import { EMPTY_AGENT_POOL_QUERY, filterAgentEntries } from "../../shared/agents/filter";
import { agentCatalogSchema, type AgentCatalogData } from "../../shared/agents/schema";
import { roomStateSchema, type RoomState } from "../../shared/room";

/*
 * 代理人目录测试：验证真实固定版本的数据可以加载并通过规范化，
 * 覆盖结构不变量、失败输入、检索语义与「规则/归档/展示同源」的派生
 * 一致性。数据来源与导入概况见 docs/specs/agent-data.md。
 */

/** 固定的数据版本：升级依赖与再生成目录时需有意识地同步更新本常量。 */
const PINNED_AGENT_DATA_VERSION = "0.2.1";

/** 固定的图片资源修订：更新图片或裁切校准时需有意识地同步更新本常量。 */
const PINNED_IMAGE_ASSETS_REVISION = "2026-10-09";

/** 构造可直接通过校验的最小目录，用于失败输入用例的基底。 */
function minimalCatalog(): AgentCatalogData {
  return agentCatalogSchema.parse({
    agentDataVersion: "0.2.1",
    source: {
      package: "@randomplay/data",
      packageVersion: "0.2.1",
      gameVersion: "3.1",
      sourceId: "nanoka-zzz",
      snapshotId: "sha256:test",
    },
    elements: [{ id: "200", name: "物理", iconPath: null }],
    specialties: [{ id: "1", name: "强攻", iconPath: null }],
    agents: [
      {
        id: "1011",
        name: "安比",
        fullName: "安比·德玛拉",
        avatarPath: null,
        elementId: "200",
        specialtyId: "1",
      },
      {
        id: "1021",
        name: "猫又",
        fullName: null,
        avatarPath: "icon.png",
        elementId: "200",
        specialtyId: "1",
      },
    ],
  });
}

/** 断言目录非法。 */
function expectInvalid(mutate: (catalog: AgentCatalogData) => void): void {
  const catalog = minimalCatalog();
  mutate(catalog);
  expect(agentCatalogSchema.safeParse(catalog).success).toBe(false);
}
describe("真实固定版本加载", () => {
  it("产物通过共享 schema 规范化，且与固定版本及安装依赖一致", () => {
    // import 本身已完成 parse；此处显式重放校验，避免依赖导入副作用。
    const parsed = agentCatalogSchema.parse(agentCatalogData);
    expect(parsed).toEqual(agentCatalogData);
    expect(agentDataVersion).toBe(PINNED_AGENT_DATA_VERSION);
    // 依赖与产物保持一致：升级 @randomplay/data 后必须重新生成目录。
    expect(calculationDataVersion.packageVersion).toBe(PINNED_AGENT_DATA_VERSION);
    expect(agentCatalogData.source).toEqual({
      package: "@randomplay/data",
      packageVersion: PINNED_AGENT_DATA_VERSION,
      gameVersion: "3.1",
      sourceId: "nanoka-zzz",
      snapshotId: expect.any(String),
    });
  });

  it("实际导入概况：58 名代理人、7 项属性、6 项特性", () => {
    expect(agentCatalogData.agents).toHaveLength(58);
    expect(agentCatalogData.elements.map((e) => `${e.id}:${e.name}`)).toEqual([
      "200:物理",
      "201:火属性",
      "202:冰属性",
      "203:电属性",
      "204:风属性",
      "205:以太",
      "300:流明",
    ]);
    expect(agentCatalogData.specialties.map((s) => `${s.id}:${s.name}`)).toEqual([
      "1:强攻",
      "2:击破",
      "3:异常",
      "4:支援",
      "5:防护",
      "6:命破",
    ]);
  });

  it("名单满足完整 BP 的最小规模（26 步互不重复）", () => {
    expect(agentCatalogData.agents.length).toBeGreaterThanOrEqual(BP_STEP_COUNT);
  });

  it("锚点核对：首名安比与末名希格莉德的字段映射", () => {
    const anby = agentCatalogData.agents[0];
    expect(anby).toMatchObject({
      id: "1011",
      name: "安比",
      fullName: "安比·德玛拉",
      elementId: "203",
      specialtyId: "2",
    });
    expect(anby?.avatarPath).toMatch(/^UI\/Sprite\/.+\.png$/);
    const last = agentCatalogData.agents.at(-1);
    expect(last).toMatchObject({ id: "1591", name: "希格莉德", fullName: "希格莉德·德拉叙尔" });
  });

  it("官方全名概况：55 名有 fullName，缺头像的三名均无全名", () => {
    const withFullName = agentCatalogData.agents.filter((entry) => entry.fullName !== null);
    expect(withFullName).toHaveLength(55);
    const without = agentCatalogData.agents.filter((entry) => entry.fullName === null);
    expect(without.map((entry) => `${entry.id}:${entry.name}`)).toEqual([
      "1381:零号·安比",
      "1531:星徽·比利",
      "1551:佩洛伊斯",
    ]);
  });

  it("缺头像代理人保留身份与筛选信息：零号·安比、星徽·比利、佩洛伊斯", () => {
    const missingAvatar = agentCatalogData.agents.filter((entry) => entry.avatarPath === null);
    expect(missingAvatar.map((entry) => `${entry.id}:${entry.name}`)).toEqual([
      "1381:零号·安比",
      "1531:星徽·比利",
      "1551:佩洛伊斯",
    ]);
    for (const entry of missingAvatar) {
      expect(entry.name).not.toBe("");
      expect(entry.elementId).toBeTruthy();
      expect(entry.specialtyId).toBeTruthy();
    }
  });

  it("图片资源引用：全部条目与分类携带固定修订内的引用", () => {
    expect(agentCatalogData.imageAssets?.revision).toBe(PINNED_IMAGE_ASSETS_REVISION);
    // 内嵌的旧圆图收录摘要：形态合法、排序确定（与清单的对齐在
    // tests/rules/agent-image-assets.test.ts 校验）。
    const legacyNames = agentCatalogData.imageAssets?.legacyCircleFileNames ?? [];
    expect(legacyNames).toHaveLength(55);
    expect([...legacyNames].sort()).toEqual(legacyNames);
    for (const name of legacyNames) expect(name).toMatch(/^IconRoleCircle[0-9]+\.webp$/);
    // 58 人全部有方图资源（含缺 avatarPath 的 1381/1531/1551，其方图来自
    // 图片资源清单，不伪造它们的旧来源路径）。
    for (const entry of agentCatalogData.agents) {
      expect(entry.iconAsset, `代理人 ${entry.id} 缺少图片资源引用`).toBeDefined();
      expect(entry.iconAsset?.icon).toMatch(/^IconRoleCrop[0-9]+$/);
      expect(entry.iconAsset?.crop.x).toBeGreaterThanOrEqual(0);
      expect(entry.iconAsset?.crop.x).toBeLessThanOrEqual(100);
      expect(entry.iconAsset?.crop.y).toBeGreaterThanOrEqual(0);
      expect(entry.iconAsset?.crop.y).toBeLessThanOrEqual(100);
    }
    for (const classification of [...agentCatalogData.elements, ...agentCatalogData.specialties]) {
      expect(classification.iconAsset, `分类 ${classification.id} 缺少图标资源引用`).toBeDefined();
    }
    // 缺 avatarPath 的三人的方图主干与其余来源推导一致。
    expect(agentCatalogData.agents.find((entry) => entry.id === "1381")?.iconAsset?.icon).toBe(
      "IconRoleCrop40",
    );
    expect(agentCatalogData.agents.find((entry) => entry.id === "1531")?.iconAsset?.icon).toBe(
      "IconRoleCrop62",
    );
    expect(agentCatalogData.agents.find((entry) => entry.id === "1551")?.iconAsset?.icon).toBe(
      "IconRoleCrop63",
    );
  });

  it("ID 升序固定排列且无重复", () => {
    const ids = agentCatalogData.agents.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const numeric = ids.map((id) => Number(id));
    for (let index = 1; index < numeric.length; index += 1) {
      expect(numeric[index - 1]).toBeLessThan(numeric[index] as number);
    }
  });

  it("每个分类都被至少一名代理人使用，条目引用均有效", () => {
    const elementIds = new Set(agentCatalogData.elements.map((entry) => entry.id));
    const specialtyIds = new Set(agentCatalogData.specialties.map((entry) => entry.id));
    const usedElements = new Set<string>();
    const usedSpecialties = new Set<string>();
    for (const agent of agentCatalogData.agents) {
      expect(elementIds.has(agent.elementId)).toBe(true);
      expect(specialtyIds.has(agent.specialtyId)).toBe(true);
      usedElements.add(agent.elementId);
      usedSpecialties.add(agent.specialtyId);
    }
    expect(usedElements.size).toBe(agentCatalogData.elements.length);
    expect(usedSpecialties.size).toBe(agentCatalogData.specialties.length);
  });
});

describe("目录 schema 拒绝无效输入", () => {
  it("代理人 ID 重复", () => {
    expectInvalid((catalog) => {
      catalog.agents[1]!.id = "1011";
    });
  });

  it("代理人为空名称（仅空白）", () => {
    expectInvalid((catalog) => {
      catalog.agents[0]!.name = "  ";
    });
    expectInvalid((catalog) => {
      catalog.agents[0]!.fullName = "  ";
    });
  });

  it("分类引用无效（elementId 不在属性表内）", () => {
    expectInvalid((catalog) => {
      catalog.agents[0]!.elementId = "999";
    });
  });

  it("代理人未按 ID 数值升序排列", () => {
    expectInvalid((catalog) => {
      catalog.agents.reverse();
    });
  });

  it("分类 ID 重复", () => {
    expectInvalid((catalog) => {
      catalog.elements.push({ ...catalog.elements[0]! });
    });
  });

  it("分类名称重复", () => {
    expectInvalid((catalog) => {
      catalog.elements.push({ id: "201", name: "物理", iconPath: null });
    });
  });

  it("存在未被任何代理人使用的分类", () => {
    expectInvalid((catalog) => {
      catalog.specialties.push({ id: "9", name: "测试特性", iconPath: null });
    });
  });

  it("agentDataVersion 与来源包版本不一致", () => {
    expectInvalid((catalog) => {
      (catalog as { agentDataVersion: string }).agentDataVersion = "0.2.0";
    });
  });

  it("图片资源引用与修订标识整体耦合：带修订缺引用、缺修订带引用均非法", () => {
    // 旧目录（无 imageAssets）仍可解析：字段全部可选。
    expect(agentCatalogSchema.safeParse(minimalCatalog()).success).toBe(true);
    // 带修订标识的新目录必须全量携带条目引用（无效引用显式失败）。
    expectInvalid((catalog) => {
      catalog.imageAssets = { revision: "2026-10-09", legacyCircleFileNames: [] };
    });
    expectInvalid((catalog) => {
      catalog.imageAssets = { revision: "2026-10-09", legacyCircleFileNames: [] };
      catalog.elements[0]!.iconAsset = "IconPhysical";
      catalog.specialties[0]!.iconAsset = "IconAttackType";
      delete catalog.agents[0]!.iconAsset;
      catalog.agents[1]!.iconAsset = { icon: "IconRoleCrop01", crop: { x: 50, y: 36 } };
    });
    expectInvalid((catalog) => {
      catalog.imageAssets = { revision: "2026-10-09", legacyCircleFileNames: [] };
      catalog.agents[0]!.iconAsset = { icon: "IconRoleCrop01", crop: { x: 50, y: 36 } };
      catalog.agents[1]!.iconAsset = { icon: "IconRoleCrop11", crop: { x: 50, y: 36 } };
      delete catalog.specialties[0]!.iconAsset;
    });
    // 没有修订标识的孤儿引用无法构造稳定公开路径，同样非法。
    expectInvalid((catalog) => {
      catalog.agents[0]!.iconAsset = { icon: "IconRoleCrop01", crop: { x: 50, y: 36 } };
    });
    expectInvalid((catalog) => {
      catalog.elements[0]!.iconAsset = "IconPhysical";
    });
  });

  it("裁切值超出 0-100 或资源主干形态非法", () => {
    const withAssets = (catalog: AgentCatalogData): void => {
      catalog.imageAssets = { revision: "2026-10-09", legacyCircleFileNames: [] };
      catalog.elements[0]!.iconAsset = "IconPhysical";
      catalog.specialties[0]!.iconAsset = "IconAttackType";
      catalog.agents[0]!.iconAsset = { icon: "IconRoleCrop01", crop: { x: 50, y: 36 } };
      catalog.agents[1]!.iconAsset = { icon: "IconRoleCrop11", crop: { x: 50, y: 36 } };
    };
    // 完整引用的新目录形态合法（这里只测形态，真实引用由真实目录覆盖）。
    const valid = minimalCatalog();
    withAssets(valid);
    expect(agentCatalogSchema.safeParse(valid).success).toBe(true);
    expectInvalid((catalog) => {
      withAssets(catalog);
      catalog.agents[0]!.iconAsset = { icon: "IconRoleCrop01", crop: { x: 50, y: 140 } };
    });
    expectInvalid((catalog) => {
      withAssets(catalog);
      catalog.agents[0]!.iconAsset = { icon: "../escape", crop: { x: 50, y: 36 } };
    });
    expectInvalid((catalog) => {
      withAssets(catalog);
      catalog.elements[0]!.iconAsset = "a/b";
    });
  });

  it("无效 ID 形态（前导零、非数字）", () => {
    expectInvalid((catalog) => {
      catalog.agents[0]!.id = "01011";
    });
    expectInvalid((catalog) => {
      catalog.agents[0]!.id = "anby";
    });
  });
});

describe("代理人池搜索与筛选", () => {
  const agents = agentCatalogData.agents;

  it("未设条件时不限制结果，保持目录顺序", () => {
    expect(filterAgentEntries(agents, EMPTY_AGENT_POOL_QUERY)).toEqual(agents);
    expect(filterAgentEntries(agents, { name: "   ", elementIds: [], specialtyIds: [] })).toEqual(
      agents,
    );
  });

  it("名称包含匹配且 trim 查询；「安比」同时命中安比与零号·安比", () => {
    const matched = filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "  安比 " });
    expect(matched.map((entry) => entry.id)).toEqual(["1011", "1381"]);
    // 全名查询仍可精确到单人。
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "零号·安比" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1381"]);
  });

  it("官方全名包含匹配：星见雅、月城柳、浅羽悠真", () => {
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "星见雅" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1091"]);
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "月城柳" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1221"]);
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "浅羽悠真" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1201"]);
  });

  it("简短名与官方全名指向同一代理人：猫又与猫宫又奈", () => {
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "猫又" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1021"]);
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "猫宫又奈" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1021"]);
  });

  it("缺 fullName 的变体仍可按简短名查询", () => {
    // 1381 零号·安比无 fullName，查询仍命中其简短名。
    expect(
      filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "星徽·比利" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["1531"]);
  });

  it("不扩展社区别名、英文代号或拼音", () => {
    expect(filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "Anby" })).toEqual([]);
    expect(filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "anbi" })).toEqual([]);
    expect(filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "xingjianya" })).toEqual(
      [],
    );
  });

  it("名称不匹配任何代理人时结果为空", () => {
    expect(filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, name: "不存在的名称" })).toEqual(
      [],
    );
  });

  it("属性多选为并集：物理或电属性", () => {
    const matched = filterAgentEntries(agents, {
      ...EMPTY_AGENT_POOL_QUERY,
      elementIds: ["200", "203"],
    });
    const expected = agents.filter(
      (entry) => entry.elementId === "200" || entry.elementId === "203",
    );
    expect(matched).toEqual(expected);
  });

  it("特性多选为并集：击破或支援", () => {
    const matched = filterAgentEntries(agents, {
      ...EMPTY_AGENT_POOL_QUERY,
      specialtyIds: ["2", "4"],
    });
    const expected = agents.filter(
      (entry) => entry.specialtyId === "2" || entry.specialtyId === "4",
    );
    expect(matched).toEqual(expected);
  });

  it("不同维度与名称之间取交集", () => {
    const matched = filterAgentEntries(agents, {
      name: "安比",
      elementIds: ["203"],
      specialtyIds: ["1", "2"],
    });
    // 零号·安比是电属性强攻，安比是电属性击破，均命中；其余含「安比」的名称不存在。
    expect(matched.map((entry) => entry.id)).toEqual(["1011", "1381"]);
    const stricter = filterAgentEntries(agents, {
      name: "安比",
      elementIds: ["203"],
      specialtyIds: ["2"],
    });
    expect(stricter.map((entry) => entry.id)).toEqual(["1011"]);
  });

  it("未知分类 ID 不命中任何代理人", () => {
    expect(filterAgentEntries(agents, { ...EMPTY_AGENT_POOL_QUERY, elementIds: ["999"] })).toEqual(
      [],
    );
  });

  it("筛选结果保持 ID 升序的目录排列", () => {
    const matched = filterAgentEntries(agents, {
      ...EMPTY_AGENT_POOL_QUERY,
      elementIds: ["204", "300", "205"],
    });
    // 风、以太、流明代理人的 ID 分散，结果应仍按目录顺序排列。
    expect(matched.length).toBeGreaterThan(0);
    const positions = matched.map((entry) =>
      agents.findIndex((candidate) => candidate.id === entry.id),
    );
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index - 1]).toBeLessThan(positions[index] as number);
    }
  });
});

describe("头像图片 URL 派生", () => {
  it("按上游已确认规则转换文档样例路径", () => {
    expect(
      toAgentImageUrl("UI/Sprite/A1DynamicLoad/IconRoleCircle/UnPacker/IconRoleCircle01.png"),
    ).toBe("https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp");
  });

  it("先 trim 再取末段文件名", () => {
    expect(
      toAgentImageUrl("  UI/Sprite/A1DynamicLoad/IconRoleCircle/UnPacker/IconRoleCircle01.png  "),
    ).toBe("https://static.nanoka.cc/assets/zzz/IconRoleCircle01.webp");
  });

  it("无来源路径或空输入返回 null", () => {
    expect(toAgentImageUrl(null)).toBeNull();
    expect(toAgentImageUrl("")).toBeNull();
    expect(toAgentImageUrl("   ")).toBeNull();
  });

  it("无 .png 扩展名的资源标识不制造图片地址", () => {
    // 上游明确 live2_d 等动画资源标识不适用本规则。
    expect(toAgentImageUrl("UISpine_Yidhari")).toBeNull();
    // roleIcon 类无扩展名路径同样不适用。
    expect(toAgentImageUrl("IconRole/UnPacker/IconRole01")).toBeNull();
  });
});

describe("目录派生一致性", () => {
  it("规则层名单与目录同源同序", () => {
    const catalog = toAgentCatalog(agentCatalogData);
    expect(catalog.agentIds).toEqual(agentCatalogData.agents.map((entry) => entry.id));
    expect(new Set(catalog.agentIds).size).toBe(catalog.agentIds.length);
  });

  it("归档展示映射覆盖全部代理人且与目录一致", () => {
    const lookup = toAgentDisplayLookup(agentCatalogData);
    expect(lookup.size).toBe(agentCatalogData.agents.length);
    for (const entry of agentCatalogData.agents) {
      const display = lookup.get(entry.id);
      expect(display, `缺少 ${entry.id} 的展示信息`).toEqual({
        name: entry.name,
        avatarUrl: `/images/agents/${PINNED_IMAGE_ASSETS_REVISION}/${entry.iconAsset?.icon}.webp`,
        avatarCrop: entry.iconAsset?.crop ?? null,
      });
    }
    // 具体样例：安比的归档头像为资源修订内的稳定本地方图路径（含裁切）。
    expect(lookup.get("1011")?.avatarUrl).toBe(
      `/images/agents/${PINNED_IMAGE_ASSETS_REVISION}/IconRoleCrop01.webp`,
    );
    expect(lookup.get("1011")?.avatarCrop).toEqual(
      agentCatalogData.agents[0]?.iconAsset?.crop ?? null,
    );
  });

  it("数据版本可进入视图与归档记录的版本合同", () => {
    const versions: VersionInfo = versionInfoSchema.parse({
      ruleVersion: "rules-test",
      agentDataVersion,
    });
    expect(versions).toEqual({
      ruleVersion: "rules-test",
      agentDataVersion: PINNED_AGENT_DATA_VERSION,
    });
  });

  it("归档投影使用真实目录：名称与头像来自同一权威目录", () => {
    // 用真实名单构造一局已完成的房间（含缺头像的佩洛伊斯），再走真实归档投影。
    const pickedAgents = agentCatalogData.agents.slice(0, BP_STEP_COUNT - 1);
    const pyrois = agentCatalogData.agents.find((entry) => entry.id === "1551");
    if (pyrois === undefined) throw new Error("测试前提失败：1551 佩洛伊斯应在目录中");
    const submissions = [...pickedAgents.map((entry) => entry.id), pyrois.id].map(
      (agentId, index) => ({ slotId: BP_STEP_ORDER[index]!, agentId }),
    );
    const completed: RoomState = roomStateSchema.parse({
      roomId: "room-catalog-test",
      name: "目录核对房间",
      lifecycle: "live",
      hostMemberId: "member-host",
      teamNames: { A: "左方", B: "右方" },
      seats: { A: "member-a", B: "member-b" },
      members: [
        { memberId: "member-host", nickname: "房主", online: true },
        { memberId: "member-a", nickname: "A 选手", online: true },
        { memberId: "member-b", nickname: "B 选手", online: true },
      ],
      revision: 1,
      bp: { status: "completed", submissions, preselect: null, version: 26 },
    });
    const snapshot = projectArchiveSnapshot({
      state: completed,
      agentDisplay: toAgentDisplayLookup(agentCatalogData),
      versions: { ruleVersion: "rules-test", agentDataVersion },
      archivedAt: "2026-10-05T00:00:00.000Z",
    });
    if (snapshot === null) throw new Error("完整对局应生成快照");
    expect(snapshot.operations).toHaveLength(BP_STEP_COUNT);
    const lookup = toAgentDisplayLookup(agentCatalogData);
    for (let index = 0; index < submissions.length; index += 1) {
      const submission = submissions[index]!;
      const expected = lookup.get(submission.agentId);
      expect(snapshot.operations[index]?.agentName).toBe(expected?.name);
      expect(snapshot.operations[index]?.agentAvatarUrl).toBe(expected?.avatarUrl);
      expect(snapshot.operations[index]?.agentAvatarCrop).toEqual(expected?.avatarCrop);
    }
    // 归档中的头像为资源修订内的稳定本地方图路径（含宽幅裁切），不是
    // 原始游戏内路径，也不是热链远程地址。
    expect(snapshot.operations[0]?.agentId).toBe("1011");
    expect(snapshot.operations[0]?.agentAvatarUrl).toBe(
      `/images/agents/${PINNED_IMAGE_ASSETS_REVISION}/IconRoleCrop01.webp`,
    );
    expect(snapshot.operations[0]?.agentAvatarCrop).toEqual(
      agentCatalogData.agents[0]?.iconAsset?.crop ?? null,
    );
    // 缺 avatarPath 的佩洛伊斯同样拥有方图资源（来自图片资源清单）。
    const pyroisOperation = snapshot.operations.find((operation) => operation.agentId === "1551");
    expect(pyroisOperation?.agentName).toBe("佩洛伊斯");
    expect(pyroisOperation?.agentAvatarUrl).toBe(
      `/images/agents/${PINNED_IMAGE_ASSETS_REVISION}/IconRoleCrop63.webp`,
    );
    expect(pyroisOperation?.agentAvatarCrop).toEqual(
      agentCatalogData.agents.find((entry) => entry.id === "1551")?.iconAsset?.crop ?? null,
    );
  });
});
