import type { Insertable, Selectable } from 'kysely';
import { describe, expectTypeOf, it } from 'vitest';
import type { DB } from './types';

describe('Kysely DB types', () => {
  it('exposes threads and messages tables', () => {
    expectTypeOf<'threads' | 'messages'>().toExtend<keyof DB>();
  });

  it('threads has user_id of uuid', () => {
    expectTypeOf<Selectable<DB['threads']>['user_id']>().toExtend<string>();
  });

  it('messages has nullable superseded_at', () => {
    // Supabase's generator emits Postgres `timestamptz` as `string` (ISO-8601),
    // so KyselifyDatabase yields `string | null` for the select side here, not
    // `Date | null`. The pg driver returns Date at runtime, but the static
    // types follow the Supabase generator output.
    expectTypeOf<Selectable<DB['messages']>['superseded_at']>().toExtend<string | null>();
  });

  it('threads requires user_id on insert', () => {
    expectTypeOf<Insertable<DB['threads']>>().toHaveProperty('user_id').toExtend<string>();
    // Required, not optional — would break if the NOT NULL constraint were dropped.
    // A type without user_id must not be assignable to Insertable<threads>.
    expectTypeOf<{ id?: string }>().not.toExtend<Insertable<DB['threads']>>();
  });

  it('messages.id is optional on insert (defaulted)', () => {
    expectTypeOf<Insertable<DB['messages']>>().toExtend<{ id?: string }>();
  });
});
