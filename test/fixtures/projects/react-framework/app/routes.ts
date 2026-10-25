import { type RouteConfig, route, index, layout, prefix } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  index("routes/home.tsx"),
  route("about", "routes/about.tsx"),
  layout("routes/auth/layout.tsx", [route("login", "routes/auth/login.tsx")]),
  ...prefix("concerts", [index("concerts/home.tsx"), route(":city", "concerts/city.tsx")]),
  ...(await flatRoutes({ rootDirectory: "blog-routes" })),
] satisfies RouteConfig;
