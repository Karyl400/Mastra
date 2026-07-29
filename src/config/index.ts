export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },
  database: {
    url: process.env.DATABASE_URL || 'file:./data/kisso.db',
  },
  notifications: {
    resend: {
      apiKey: process.env.RESEND_API_KEY || '',
    },
    from: process.env.NOTIFICATION_FROM || 'noreply@kisso.com',
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    },
  },
  app: {
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development',
  },
};
