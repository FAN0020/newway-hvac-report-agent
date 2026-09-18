process.env.HVAC_HOST = '0.0.0.0';

const { startServer } = await import('../src/server.js');

try {
  await startServer();
} catch (error) {
  console.error(`Demo server refused to start: ${error.message}`);
  process.exitCode = 1;
}
