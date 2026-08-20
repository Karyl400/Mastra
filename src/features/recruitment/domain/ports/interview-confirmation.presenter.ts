export interface InterviewConfirmationPayload {
  readonly to: string;
  readonly candidateName?: string;
  readonly startsAt: string;
  readonly position?: string;
  readonly location?: string;
  readonly replyTo?: string;
  readonly requesterUserId: string;
}

export interface InterviewConfirmationPresenter {
  buildConfirmationText(input: {
    payload: InterviewConfirmationPayload;
    humanReadableDate: string;
    subject: string;
    body: string;
  }): string;

  fallbackText(candidateName?: string): string;
}
