<template>
  <!-- 房间路径改变时重建入口与会话，触发旧成员/展示连接的卸载清理。
       查询参数与 hash 不定义房间身份，不因此重连。 -->
  <RouterView :key="$route.path" />
</template>
