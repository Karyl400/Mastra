import { logger } from '../../shared/logger';

let dbShutdownHandlersRegistered = false;

export function registerDbShutdownHandlers(close: () => Promise<void>): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, closing database connection gracefully...`);
    try {
      await close();
      logger.info('Database connection closed during shutdown');
    } catch (error) {
      logger.error('Error during database shutdown', { error });
    }
  };

  if (!dbShutdownHandlersRegistered) {
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGQUIT', () => {
      void shutdown('SIGQUIT');
    });
    dbShutdownHandlersRegistered = true;
  }
}
