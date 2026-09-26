import json,sys,os
root=sys.argv[1]
for name in sys.argv[2:]:
    p=os.path.join(root,'shots',name,'events.json')
    if not os.path.exists(p): print(name,'(no events.json)'); continue
    d=json.load(open(p)); ev=d['events']; st=d['states']
    print(f"== {name}: {d['frames']} frames")
    for k in sorted(ev,key=int):
        for e in ev[k]:
            if e['kind'] in ('hit','ko','ringOut','roundEnd','matchEnd','dash','jump','heatFull'):
                print(f"  f{int(k):4d} {e['kind']:9s} " + " ".join(f"{a}={b}" for a,b in e.items() if a!='kind'))
    last=st[str(d['frames']-1)]; print("  end:", [(f['x'],f['hp'],f['heat']) for f in last['f']], 'phase',last['phase'])
