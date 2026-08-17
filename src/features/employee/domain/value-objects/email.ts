import { emailSchema } from '../../../../shared/validation';
import { ValidationError } from '../../../../shared/errors';

export class Email {
  private constructor(public readonly value: string) {}

  static create(email: string): Email {
    const result = emailSchema.safeParse(email);
    if (!result.success) {
      throw new ValidationError(`Invalid email format: ${email}`);
    }
    return new Email(result.data);
  }

  toString(): string {
    return this.value;
  }
}
