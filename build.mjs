import { build } from "esbuild";
import esbuildPluginLicense from "esbuild-plugin-license";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  outfile: "dist/index.js",
  sourcemap: true,
  plugins: [
    esbuildPluginLicense({
      thirdParty: {
        output: {
          file: "dist/licenses.txt",
        },
      },
    }),
  ],
});
