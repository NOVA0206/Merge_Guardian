import next from "eslint-config-next";

const config = [...next, { ignores: [".next/**", "node_modules/**", "tests/fixtures/**", "next-env.d.ts"] }];

export default config;
