import { createRouter, createWebHistory } from "vue-router";
import HomePage from "./pages/HomePage.vue";

// 首版页面入口见 docs/specs/implementation-plan.md；
// 房间、展示与记录页在对应 PR 中逐步加入。
export default createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: HomePage,
    },
    {
      path: "/:pathMatch(.*)*",
      name: "not-found",
      component: () => import("./pages/NotFoundPage.vue"),
    },
  ],
});
