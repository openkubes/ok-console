/** Keep actionable source details while translating internal validation terminology. */
export function operatorWarnings(warnings?: string[]) {
  return warnings?.map(message => message === 'Observed-state values were withheld by grammar checks or the Console redaction boundary.'
    ? 'Some observation values could not be safely displayed.'
    : message).join(' ')
}
