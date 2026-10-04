import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";

// 页面入口见 docs/specs/implementation-plan.md「页面与接口边界」；
// 展示页与只读记录页在对应 PR 中加入。
export default createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: HomePage,
    },
    {
      path: "/rooms/:roomId",
      name: "room",
      component: () => import("./pages/RoomPage.vue"),
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("./pages/NotFoundPage.vue"),
    },
  ],
});
