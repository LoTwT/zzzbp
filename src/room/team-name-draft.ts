/**
 * 队名编辑草稿状态：用「编辑代次 + 提交快照」区分本地编辑与权威同步。
 *
 * 解决的竞态（不能以字符串等于旧权威值判断「没有新编辑」）：
 * - 保存请求在途时用户继续编辑（改成第三个值、或改回旧权威值）——
 *   该次成功只能收敛与提交对应且未被后续编辑替代的草稿；
 * - 无后续编辑的成功：草稿按本次提交的规范化值（服务器 trim 后落库值）
 *   收敛，避免带空格输入永远无法追平、保存按钮常驻可点；
 * - 无关广播（他人入房等 revision 递增）与失败回执：一律保留草稿；
 * - 未编辑状态：跟随外部改名。
 *
 * 成功/失败由调用方在命令回执结算时传入（组件经会话的 pending 消失且
 * 无 scope 错误判定成功；结果未知的完整流程属 PR7）。
 */

/** 单侧队伍名的草稿状态机。 */
export class TeamNameDraft {
  /** 当前权威值（最近一次视图携带的存储值）。 */
  private authorityValue: string;
  /** 输入框当前草稿。 */
  private draftValue: string;
  /** 是否存在未收敛到权威值的本地编辑。 */
  private dirtyFlag = false;
  /** 本地编辑代次：每次输入事件递增，用于识别「保存之后是否又有编辑」。 */
  private editGeneration = 0;
  /** 在途保存：提交时的编辑代次；null 表示无在途保存。 */
  private saveGeneration: number | null = null;
  /** 在途保存的规范化提交值（trim 后落库值）。 */
  private saveValue: string | null = null;

  constructor(initialAuthority: string) {
    this.authorityValue = initialAuthority;
    this.draftValue = initialAuthority;
  }

  /** 输入框当前草稿。 */
  get draft(): string {
    return this.draftValue;
  }

  /** 是否存在未收敛的本地编辑（保存按钮据此判断有无待保存内容）。 */
  get dirty(): boolean {
    return this.dirtyFlag;
  }

  /** 当前权威值。 */
  get authority(): string {
    return this.authorityValue;
  }

  /** 是否有在途保存。 */
  get saving(): boolean {
    return this.saveGeneration !== null;
  }

  /** 权威视图更新：未编辑时跟随（含外部改名）；有未收敛编辑时保留草稿。 */
  setAuthority(value: string): void {
    this.authorityValue = value;
    if (!this.dirtyFlag) {
      this.draftValue = value;
    }
  }

  /** 用户输入：记录新的本地编辑，代次递增（即使值恰好等于权威值）。 */
  edit(value: string): void {
    this.draftValue = value;
    this.dirtyFlag = true;
    this.editGeneration += 1;
  }

  /**
   * 发起保存：登记提交快照（当前草稿的 trim 规范化值）与提交时编辑代次。
   * 返回规范化提交值供命令载荷使用；已有在途保存时拒绝（返回 null）。
   */
  beginSave(): string | null {
    if (this.saveGeneration !== null) return null;
    this.saveGeneration = this.editGeneration;
    this.saveValue = this.draftValue.trim();
    return this.saveValue;
  }

  /**
   * 保存未实际发出（会话拒绝发送等）：撤销提交登记，草稿保持待保存状态。
   */
  abortSave(): void {
    this.saveGeneration = null;
    this.saveValue = null;
  }

  /**
   * 保存结算：
   * - 成功且保存后无新编辑 → 草稿收敛为本次提交的规范化值，清除 dirty；
   * - 成功但保存后有新编辑（代次已推进）→ 保留较新的草稿，维持 dirty；
   * - 失败 → 保留草稿，维持 dirty（允许直接重试或先修改再保存）。
   */
  settleSave(outcome: { readonly ok: boolean }): void {
    if (this.saveGeneration === null) return;
    if (outcome.ok && this.editGeneration === this.saveGeneration && this.saveValue !== null) {
      this.draftValue = this.saveValue;
      this.dirtyFlag = false;
    }
    this.saveGeneration = null;
    this.saveValue = null;
  }
}
