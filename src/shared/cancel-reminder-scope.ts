export interface CancellableReminder {
  readonly subject: string;
  readonly deliveredOn: string | null;
}
