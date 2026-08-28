export class DatabaseConnectionError extends Error {
  public readonly code = 'DB_CONNECTION_ERROR';

  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export class DatabaseMigrationError extends Error {
  public readonly code = 'DB_MIGRATION_ERROR';

  constructor(
    message: string,
    public override readonly cause?: Error,
  ) {
    super(message);
    this.name = 'DatabaseMigrationError';
  }
}
