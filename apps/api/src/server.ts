import { buildApp } from './app.js';

async function main() {
  const { app, ctx } = await buildApp();

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({
    port: ctx.env.API_PORT,
    host: ctx.env.API_HOST,
  });

  app.log.info(`DroidForge API listening on http://${ctx.env.API_HOST}:${ctx.env.API_PORT}`);
  app.log.info(`Swagger UI available at http://localhost:${ctx.env.API_PORT}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
