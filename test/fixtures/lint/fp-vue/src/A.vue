<template>
  <div>
    <label for="n">Name</label><input id="n" />
    <label>Email <input type="email" /></label>
    <img v-bind="$attrs" />
    <img src="missing.png" />
    <input autofocus />
  </div>
</template>
