import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";

// 页面入口见 docs/specs/implementation-plan.md「页面与接口边界」；
// /rooms/:roomId 按生命周期分流为首次入房、实时房间或只读记录（PR9）。
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
