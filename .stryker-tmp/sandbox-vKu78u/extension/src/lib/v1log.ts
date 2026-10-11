// @ts-nocheck
// v1 segment format: bodies (selftext) stored once per hash, sightings as
// small lines carrying their own metadata plus the body hash.
//
//   {"k":"body","h":"<sha256 of selftext>","selftext":"..."}
//   {"k":"sight","oid":...,"post_id":...,"t":<captured_at>,"src":...,"by":...,
//    "h":"<selftext hash or EMPTY_BODY_HASH>","post_at":...,"title":...,...}
//
// The reader expands sights back into observation records so the summarize()
// path works unchanged. Pure module: no chrome or node imports; the digest
// function is injected (crypto.subtle in the worker, node:crypto in the
// builder).
function stryNS_9fa48() {
  var g =
    (typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis) ||
    new Function('return this')();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (
    ns.activeMutant === undefined &&
    g.process &&
    g.process.env &&
    g.process.env.__STRYKER_ACTIVE_MUTANT__
  ) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov =
    ns.mutantCoverage ||
    (ns.mutantCoverage = {
      static: {},
      perTest: {},
    });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import {
  BodyLineSchema,
  EMPTY_BODY_HASH,
  ObservationRecordSchema,
  SightLineSchema,
  V1LineSchema,
  type BodyLine,
  type ObservationRecord,
  type SightLine,
  type V1Line,
} from './schema.ts';
export { EMPTY_BODY_HASH };
export type { BodyLine, ObservationRecord, SightLine, V1Line };

/** Digest function injected by the caller: hex sha256 of bytes. */
export type Digest = (bytes: Uint8Array) => Promise<string>;
const SIGHT_FIELDS = [
  'post_at',
  'title',
  'author',
  'subreddit',
  'permalink',
  'content_href',
  'thumb_href',
  'post_type',
] as const;
const NULL_BODY_PLACEHOLDERS = stryMutAct_9fa48('13')
  ? []
  : (stryCov_9fa48('13'),
    [
      stryMutAct_9fa48('14') ? '' : (stryCov_9fa48('14'), '[removed]'),
      stryMutAct_9fa48('15') ? '' : (stryCov_9fa48('15'), '[deleted]'),
    ]);

/** Body text worth storing: non-empty and not a reddit placeholder. */
export function selftextOf(record: ObservationRecord): string {
  if (stryMutAct_9fa48('16')) {
    {
    }
  } else {
    stryCov_9fa48('16');
    const t = record.selftext;
    if (
      stryMutAct_9fa48('19')
        ? t === undefined && t.length === 0
        : stryMutAct_9fa48('18')
          ? false
          : stryMutAct_9fa48('17')
            ? true
            : (stryCov_9fa48('17', '18', '19'),
              (stryMutAct_9fa48('21')
                ? t !== undefined
                : stryMutAct_9fa48('20')
                  ? false
                  : (stryCov_9fa48('20', '21'), t === undefined)) ||
                (stryMutAct_9fa48('23')
                  ? t.length !== 0
                  : stryMutAct_9fa48('22')
                    ? false
                    : (stryCov_9fa48('22', '23'), t.length === 0)))
    )
      return stryMutAct_9fa48('24') ? 'Stryker was here!' : (stryCov_9fa48('24'), '');
    return NULL_BODY_PLACEHOLDERS.includes(t)
      ? stryMutAct_9fa48('25')
        ? 'Stryker was here!'
        : (stryCov_9fa48('25'), '')
      : t;
  }
}

/** Hex sha256 of the record's selftext using the injected digest implementation. */
export async function bodyHash(record: ObservationRecord, digest: Digest): Promise<string> {
  if (stryMutAct_9fa48('26')) {
    {
    }
  } else {
    stryCov_9fa48('26');
    const text = selftextOf(record);
    if (
      stryMutAct_9fa48('29')
        ? text !== ''
        : stryMutAct_9fa48('28')
          ? false
          : stryMutAct_9fa48('27')
            ? true
            : (stryCov_9fa48('27', '28', '29'),
              text === (stryMutAct_9fa48('30') ? 'Stryker was here!' : (stryCov_9fa48('30'), '')))
    )
      return EMPTY_BODY_HASH;
    return digest(new TextEncoder().encode(text));
  }
}
export function bodyLine(record: ObservationRecord, hash: string): BodyLine {
  if (stryMutAct_9fa48('31')) {
    {
    }
  } else {
    stryCov_9fa48('31');
    return BodyLineSchema.parse(
      stryMutAct_9fa48('32')
        ? {}
        : (stryCov_9fa48('32'),
          {
            k: stryMutAct_9fa48('33') ? '' : (stryCov_9fa48('33'), 'body'),
            h: hash,
            selftext: selftextOf(record),
          }),
    );
  }
}

/** Copy a record field onto the sight line when it carries information. */
function applySightField(
  line: SightLine,
  record: ObservationRecord,
  key: (typeof SIGHT_FIELDS)[number],
): void {
  if (stryMutAct_9fa48('34')) {
    {
    }
  } else {
    stryCov_9fa48('34');
    const value = record[key];
    if (
      stryMutAct_9fa48('37')
        ? (value === undefined || value === null) && value === ''
        : stryMutAct_9fa48('36')
          ? false
          : stryMutAct_9fa48('35')
            ? true
            : (stryCov_9fa48('35', '36', '37'),
              (stryMutAct_9fa48('39')
                ? value === undefined && value === null
                : stryMutAct_9fa48('38')
                  ? false
                  : (stryCov_9fa48('38', '39'),
                    (stryMutAct_9fa48('41')
                      ? value !== undefined
                      : stryMutAct_9fa48('40')
                        ? false
                        : (stryCov_9fa48('40', '41'), value === undefined)) ||
                      (stryMutAct_9fa48('43')
                        ? value !== null
                        : stryMutAct_9fa48('42')
                          ? false
                          : (stryCov_9fa48('42', '43'), value === null)))) ||
                (stryMutAct_9fa48('45')
                  ? value !== ''
                  : stryMutAct_9fa48('44')
                    ? false
                    : (stryCov_9fa48('44', '45'),
                      value === (stryMutAct_9fa48('46') ? 'Stryker was here!' : (stryCov_9fa48('46'), '')))))
    )
      return;
    (line as Record<string, unknown>)[key] = value;
  }
}

/** Copy a metric onto the sight line when it is known. */
function applyMetric(line: SightLine, metric: number | null, key: 'score' | 'comments' | 'ratio'): void {
  if (stryMutAct_9fa48('47')) {
    {
    }
  } else {
    stryCov_9fa48('47');
    if (
      stryMutAct_9fa48('50')
        ? metric !== null
        : stryMutAct_9fa48('49')
          ? false
          : stryMutAct_9fa48('48')
            ? true
            : (stryCov_9fa48('48', '49', '50'), metric === null)
    )
      return;
    (line as Record<string, unknown>)[key] = metric;
  }
}
export function sightLine(record: ObservationRecord, hash: string): SightLine {
  if (stryMutAct_9fa48('51')) {
    {
    }
  } else {
    stryCov_9fa48('51');
    const m = record.metrics;
    const line: SightLine = stryMutAct_9fa48('52')
      ? {}
      : (stryCov_9fa48('52'),
        {
          k: stryMutAct_9fa48('53') ? '' : (stryCov_9fa48('53'), 'sight'),
          oid: record.observation_id,
          post_id: record.post_id,
          t: record.captured_at,
          src: record.source_endpoint,
          by: record.contributed_by,
          h: hash,
        });
    if (
      stryMutAct_9fa48('56')
        ? record.pooled_at === null
        : stryMutAct_9fa48('55')
          ? false
          : stryMutAct_9fa48('54')
            ? true
            : (stryCov_9fa48('54', '55', '56'), record.pooled_at !== null)
    )
      line.pooled_at = record.pooled_at;
    for (const key of SIGHT_FIELDS)
      if (stryMutAct_9fa48('57')) {
      } else {
        stryCov_9fa48('57');
        applySightField(line, record, key);
      }
    applyMetric(line, m.score, stryMutAct_9fa48('59') ? '' : (stryCov_9fa48('59'), 'score'));
    applyMetric(line, m.comments, stryMutAct_9fa48('61') ? '' : (stryCov_9fa48('61'), 'comments'));
    applyMetric(line, m.upvote_ratio, stryMutAct_9fa48('63') ? '' : (stryCov_9fa48('63'), 'ratio'));
    return SightLineSchema.parse(line);
  }
}

/** Split records into v1 lines: one body line per unseen selftext hash,
 * a sight per record. knownHashes: hashes committed in earlier segments;
 * callers add newly seen hashes only after a successful commit. */
export async function toV1Lines(
  records: ObservationRecord[],
  knownHashes: Set<string>,
  digest: Digest,
): Promise<V1Line[]> {
  if (stryMutAct_9fa48('64')) {
    {
    }
  } else {
    stryCov_9fa48('64');
    const lines: V1Line[] = stryMutAct_9fa48('65') ? ['Stryker was here'] : (stryCov_9fa48('65'), []);
    const emitted = new Set<string>();
    for (const raw of records) {
      if (stryMutAct_9fa48('66')) {
        {
        }
      } else {
        stryCov_9fa48('66');
        const record = ObservationRecordSchema.parse(raw);
        if (
          stryMutAct_9fa48('69')
            ? record.post_id === '' && record.observation_id === ''
            : stryMutAct_9fa48('68')
              ? false
              : stryMutAct_9fa48('67')
                ? true
                : (stryCov_9fa48('67', '68', '69'),
                  (stryMutAct_9fa48('71')
                    ? record.post_id !== ''
                    : stryMutAct_9fa48('70')
                      ? false
                      : (stryCov_9fa48('70', '71'),
                        record.post_id ===
                          (stryMutAct_9fa48('72') ? 'Stryker was here!' : (stryCov_9fa48('72'), '')))) ||
                    (stryMutAct_9fa48('74')
                      ? record.observation_id !== ''
                      : stryMutAct_9fa48('73')
                        ? false
                        : (stryCov_9fa48('73', '74'),
                          record.observation_id ===
                            (stryMutAct_9fa48('75') ? 'Stryker was here!' : (stryCov_9fa48('75'), '')))))
        )
          continue;
        const h = await bodyHash(record, digest);
        if (
          stryMutAct_9fa48('78')
            ? (h !== EMPTY_BODY_HASH && !knownHashes.has(h)) || !emitted.has(h)
            : stryMutAct_9fa48('77')
              ? false
              : stryMutAct_9fa48('76')
                ? true
                : (stryCov_9fa48('76', '77', '78'),
                  (stryMutAct_9fa48('80')
                    ? h !== EMPTY_BODY_HASH || !knownHashes.has(h)
                    : stryMutAct_9fa48('79')
                      ? true
                      : (stryCov_9fa48('79', '80'),
                        (stryMutAct_9fa48('82')
                          ? h === EMPTY_BODY_HASH
                          : stryMutAct_9fa48('81')
                            ? true
                            : (stryCov_9fa48('81', '82'), h !== EMPTY_BODY_HASH)) &&
                          (stryMutAct_9fa48('83')
                            ? knownHashes.has(h)
                            : (stryCov_9fa48('83'), !knownHashes.has(h))))) &&
                    (stryMutAct_9fa48('84') ? emitted.has(h) : (stryCov_9fa48('84'), !emitted.has(h))))
        ) {
          if (stryMutAct_9fa48('85')) {
            {
            }
          } else {
            stryCov_9fa48('85');
            if (stryMutAct_9fa48('86')) {
            } else {
              stryCov_9fa48('86');
              emitted.add(h);
            }
            if (stryMutAct_9fa48('87')) {
            } else {
              stryCov_9fa48('87');
              lines.push(bodyLine(record, h));
            }
          }
        }
        if (stryMutAct_9fa48('88')) {
        } else {
          stryCov_9fa48('88');
          lines.push(sightLine(record, h));
        }
      }
    }
    return lines;
  }
}

/** The hashes a batch introduced (add these to knownHashes only after commit). */
export function hashesOf(lines: V1Line[]): Set<string> {
  if (stryMutAct_9fa48('89')) {
    {
    }
  } else {
    stryCov_9fa48('89');
    const out = new Set<string>();
    for (const line of lines)
      if (
        stryMutAct_9fa48('92')
          ? line.k !== 'body'
          : stryMutAct_9fa48('91')
            ? false
            : stryMutAct_9fa48('90')
              ? true
              : (stryCov_9fa48('90', '91', '92'),
                line.k === (stryMutAct_9fa48('93') ? '' : (stryCov_9fa48('93'), 'body')))
      )
        if (stryMutAct_9fa48('94')) {
        } else {
          stryCov_9fa48('94');
          out.add(line.h);
        }
    return out;
  }
}
type Accumulator = {
  bodies: Map<string, BodyLine>;
  records: ObservationRecord[];
};

/** `value ?? fallback` with a narrow signature the lint rules can verify. */
function defined<T>(value: T | null | undefined, fallback: T): T {
  if (stryMutAct_9fa48('95')) {
    {
    }
  } else {
    stryCov_9fa48('95');
    return stryMutAct_9fa48('96') ? value && fallback : (stryCov_9fa48('96'), value ?? fallback);
  }
}

/** Attach the stored body for a sight that references one. */
function attachBody(acc: Accumulator, record: ObservationRecord, hash: string): void {
  if (stryMutAct_9fa48('97')) {
    {
    }
  } else {
    stryCov_9fa48('97');
    if (
      stryMutAct_9fa48('100')
        ? hash !== EMPTY_BODY_HASH
        : stryMutAct_9fa48('99')
          ? false
          : stryMutAct_9fa48('98')
            ? true
            : (stryCov_9fa48('98', '99', '100'), hash === EMPTY_BODY_HASH)
    )
      return;
    const body = acc.bodies.get(hash);
    if (
      stryMutAct_9fa48('103')
        ? body === undefined
        : stryMutAct_9fa48('102')
          ? false
          : stryMutAct_9fa48('101')
            ? true
            : (stryCov_9fa48('101', '102', '103'), body !== undefined)
    )
      record.selftext = body.selftext;
  }
}
function acceptSight(acc: Accumulator, line: SightLine): void {
  if (stryMutAct_9fa48('104')) {
    {
    }
  } else {
    stryCov_9fa48('104');
    const metrics = stryMutAct_9fa48('105')
      ? {}
      : (stryCov_9fa48('105'),
        {
          score: defined(line.score, null),
          comments: defined(line.comments, null),
          upvote_ratio: defined(line.ratio, null),
        });
    const record: ObservationRecord = stryMutAct_9fa48('106')
      ? {}
      : (stryCov_9fa48('106'),
        {
          observation_id: line.oid,
          post_id: line.post_id,
          post_at: defined(line.post_at, null),
          captured_at: line.t,
          source_endpoint: line.src,
          contributed_by: line.by,
          pooled_at: defined(line.pooled_at, null),
          title: defined(line.title, null),
          author: defined(line.author, null),
          subreddit: defined(line.subreddit, null),
          permalink: defined(
            line.permalink,
            stryMutAct_9fa48('107') ? 'Stryker was here!' : (stryCov_9fa48('107'), ''),
          ),
          content_href: defined(line.content_href, null),
          thumb_href: defined(line.thumb_href, null),
          post_type: defined(line.post_type, null),
          metrics,
        });
    if (stryMutAct_9fa48('108')) {
    } else {
      stryCov_9fa48('108');
      attachBody(acc, record, line.h);
    }
    if (stryMutAct_9fa48('109')) {
    } else {
      stryCov_9fa48('109');
      acc.records.push(record);
    }
  }
}

/** Expand v1 lines back into observation records; malformed lines are skipped. */
export function fromV1Lines(lines: unknown[]): ObservationRecord[] {
  if (stryMutAct_9fa48('110')) {
    {
    }
  } else {
    stryCov_9fa48('110');
    const acc: Accumulator = stryMutAct_9fa48('111')
      ? {}
      : (stryCov_9fa48('111'),
        {
          bodies: new Map(),
          records: stryMutAct_9fa48('112') ? ['Stryker was here'] : (stryCov_9fa48('112'), []),
        });
    for (const entry of lines) {
      if (stryMutAct_9fa48('113')) {
        {
        }
      } else {
        stryCov_9fa48('113');
        const parsed = V1LineSchema.safeParse(entry);
        if (
          stryMutAct_9fa48('116')
            ? false
            : stryMutAct_9fa48('115')
              ? true
              : stryMutAct_9fa48('114')
                ? parsed.success
                : (stryCov_9fa48('114', '115', '116'), !parsed.success)
        )
          continue;
        if (
          stryMutAct_9fa48('119')
            ? parsed.data.k !== 'body'
            : stryMutAct_9fa48('118')
              ? false
              : stryMutAct_9fa48('117')
                ? true
                : (stryCov_9fa48('117', '118', '119'),
                  parsed.data.k === (stryMutAct_9fa48('120') ? '' : (stryCov_9fa48('120'), 'body')))
        ) {
          if (stryMutAct_9fa48('121')) {
          } else {
            stryCov_9fa48('121');
            acc.bodies.set(parsed.data.h, parsed.data);
          }
        } else if (stryMutAct_9fa48('122')) {
        } else {
          stryCov_9fa48('122');
          acceptSight(acc, parsed.data);
        }
      }
    }
    return acc.records;
  }
}

/** Parse raw JSONL text into line objects, skipping malformed lines. */
export function parseV1Text(text: string): V1Line[] {
  if (stryMutAct_9fa48('123')) {
    {
    }
  } else {
    stryCov_9fa48('123');
    const lines: V1Line[] = stryMutAct_9fa48('124') ? ['Stryker was here'] : (stryCov_9fa48('124'), []);
    for (const raw of text.split(stryMutAct_9fa48('125') ? '' : (stryCov_9fa48('125'), '\n'))) {
      if (stryMutAct_9fa48('126')) {
        {
        }
      } else {
        stryCov_9fa48('126');
        if (
          stryMutAct_9fa48('129')
            ? raw.trim() !== ''
            : stryMutAct_9fa48('128')
              ? false
              : stryMutAct_9fa48('127')
                ? true
                : (stryCov_9fa48('127', '128', '129'),
                  (stryMutAct_9fa48('130') ? raw : (stryCov_9fa48('130'), raw.trim())) ===
                    (stryMutAct_9fa48('131') ? 'Stryker was here!' : (stryCov_9fa48('131'), '')))
        )
          continue;
        try {
          if (stryMutAct_9fa48('132')) {
            {
            }
          } else {
            stryCov_9fa48('132');
            const parsed = V1LineSchema.safeParse(JSON.parse(raw));
            if (
              stryMutAct_9fa48('134')
                ? false
                : stryMutAct_9fa48('133')
                  ? true
                  : (stryCov_9fa48('133', '134'), parsed.success)
            )
              if (stryMutAct_9fa48('135')) {
              } else {
                stryCov_9fa48('135');
                lines.push(parsed.data);
              }
          }
        } catch {
          // not JSON: skip the line
        }
      }
    }
    return lines;
  }
}
