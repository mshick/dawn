import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'dawn',
  eventKey: process.env.INNGEST_EVENT_KEY,
});
