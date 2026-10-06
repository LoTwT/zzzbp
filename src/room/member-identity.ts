import type { MemberSelfInfo } from "../../shared/contracts/views";
import { sideLabel } from "./host-panels";

/**
 * 本人身份提示（docs/specs/room-layout.md「本人身份提示」）。
 *
 * 实时操作房间底部操作栏常驻显示本人昵称与当前身份：只复用成员视图的
 * self 字段（昵称、是否房主、当前席位），不引入账户系统或新的身份接口。
 * 房主兼任选手时同时显示两种身份；左/右方对应固定的 A/B 席位，换人后
 * 随服务端最新视图更新。归档记录页与匿名展示页没有成员身份，不伪造。
 */
export function memberIdentityText(self: MemberSelfInfo): string {
  const roles: string[] = [];
  if (self.isHost) roles.push("房主");
  if (self.seatTeam !== null) roles.push(`${sideLabel(self.seatTeam)}选手`);
  // 既非房主也未占席即观众；房主权限独立于席位，被换下后仍显示「房主」。
  if (roles.length === 0) roles.push("观众");
  return [self.nickname, ...roles].join(" · ");
}
