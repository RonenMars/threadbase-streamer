import json,glob,sys,collections
def pct(a,p): a=sorted(a); return a[min(len(a)-1,int(p*len(a)))] if a else None
def stats(a): return f"n={len(a)} min={min(a):.1f} p50={pct(a,.5):.1f} p95={pct(a,.95):.1f} p99={pct(a,.99):.1f} max={max(a):.1f}" if a else "n=0"
recs=[json.loads(l) for f in sys.argv[1:] for l in open(f)]
cl=[r for r in recs if r['ev']=='clear']
pw=[r['potentialWindowMs'] for r in cl if r.get('potentialWindowMs') is not None]
print("ALL servers potential window:",stats(pw))
print("  count >50ms:",sum(x>50 for x in pw)," >100ms:",sum(x>100 for x in pw)," >200ms:",sum(x>200 for x in pw))
by=collections.defaultdict(list)
for r in cl: by[r['file']].append(r['potentialWindowMs'])
print("\nper file (top 25 by max):")
for f,a in sorted(by.items(),key=lambda kv:-max(kv[1]))[:25]: print(f"  {f:55s} {stats(a)}")
for f in ['session-status-line.test.ts','session-settings.test.ts','conversation-search-target.test.ts','agent-phase-live.test.ts','external-live-tails.test.ts','offset-index-detail.test.ts','server.test.ts']:
  if f in by: print(f"  [focus] {f:45s} {stats(by[f])}")
fg=[r for r in recs if r['ev']=='firstGated']
print("\nfirst gated request, per focus file (sinceListenMs, i.e. after awaitReady where used):")
g=collections.defaultdict(list)
for r in fg: g[r['file']].append(r['sinceListenMs'])
for f in ['session-status-line.test.ts','session-settings.test.ts','conversation-search-target.test.ts','agent-phase-live.test.ts','external-live-tails.test.ts','offset-index-detail.test.ts']:
  if f in g: print(f"  {f:45s} {stats([x for x in g[f] if x is not None])}")
rej=[r for r in recs if (r['ev']=='firstGated' and r['rejected']) or r['ev']=='rejected']
print("\nactual 503s served:",len(rej)); c=collections.Counter((r['file'],r.get('rejected') or r.get('state')) for r in rej); [print("  ",k,v) for k,v in c.most_common(15)]
