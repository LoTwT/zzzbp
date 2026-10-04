import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";

// 页面入口见 docs/specs/implementation-plan.md「页面与接口边界」；
// 只读记录页在 PR9 加入。
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
      path: "/rooms/:roomId/display",
      name: "room-display",
      component: () => import("./pages/DisplayPage.vue"),
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("./pages/NotFoundPage.vue"),
    },
  ],
});
