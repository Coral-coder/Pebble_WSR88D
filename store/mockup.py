#!/usr/bin/env python3
"""Generate the appstore listing assets (screenshots + banner + icon).

These are listing/marketing images, NOT bundled into the .pbw. Run from the
repo root:  python3 store/mockup.py   (requires Pillow)
"""
import math
from PIL import Image, ImageDraw, ImageFont

SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SANSB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
MONOB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
def f(p, s): return ImageFont.truetype(p, s)

RADAR = [(0,180,60),(120,210,40),(245,210,40),(245,140,30),(220,40,30)]
RADAR_BW = [(255,255,255),(200,200,200),(150,150,150),(95,95,95),(40,40,40)]


def draw_face(W, H, mono=False, round_=False):
    """Rectangular (or round-masked) watchface mockup at the given size."""
    img = Image.new("RGB", (W, H), (255,255,255)); d = ImageDraw.Draw(img)
    s = H / 228.0
    hdr = int(round((52 if round_ else 64)*s)); ftr = int(round((20 if round_ else 18)*s))
    pal = RADAR_BW if mono else RADAR
    water = (90,90,90) if mono else (200,200,200)

    rx = W*0.74 if round_ else W*0.72
    d.polygon([(rx,hdr),(W,hdr),(W,H-ftr),(rx+W*0.06,H-ftr),
               (rx-W*0.04,(hdr+H-ftr)/2)], fill=water)
    def road(pts, w): d.line(pts, fill=(0,0,0), width=max(1,int(round(w*s))))
    band = H-ftr-hdr
    road([(0,hdr+band*0.30),(W,hdr+band*0.18)],3)
    road([(0,hdr+band*0.72),(rx,hdr+band*0.85)],3)
    road([(W*0.27,hdr),(W*0.34,H-ftr)],2)
    road([(W*0.56,hdr),(W*0.50,H-ftr)],2)
    for fy in (0.45,0.60): road([(0,hdr+band*fy),(rx,hdr+band*(fy+0.04))],1)
    def blob(bx,by,r):
        for i,c in enumerate(pal):
            rr=r*(1-i/len(pal)); d.ellipse([bx-rr,by-rr,bx+rr,by+rr],fill=c)
    blob(W*0.36,hdr+band*0.42,W*0.16); blob(W*0.55,hdr+band*0.68,W*0.10)

    d.rectangle([0,0,W,hdr], fill=(0,0,0))
    d.rectangle([0,H-ftr,W,H], fill=(0,0,0))
    def ctr(txt, font, y):
        w=d.textlength(txt,font=font); d.text(((W-w)/2,y),txt,font=font,fill=(255,255,255))
    if round_:                                   # centered, inset for round screens
        ctr("10:42", f(MONOB,int(30*s)), int(4*s))
        ctr("Wed Jun 25", f(SANSB,int(13*s)), hdr-int(18*s))
        ctr("10:40   28mi", f(SANSB,int(12*s)), H-ftr+int(2*s))
    else:                                        # left clock + right weather column
        d.text((int(6*s),int(4*s)),"10:42",font=f(MONOB,int(34*s)),fill=(255,255,255))
        d.text((int(6*s),hdr-int(20*s)),"Wed Jun 25",font=f(SANSB,int(14*s)),fill=(255,255,255))
        sm=f(SANSB,int(12*s))
        for txt,y in [("85%",4),("72° Clear",18),("H78 L55",31),("Rain 30%",44)]:
            w=d.textlength(txt,font=sm); d.text((W-int(4*s)-w,int(y*s)),txt,font=sm,fill=(255,255,255))
        ctr("10:40   28mi", f(SANSB,int(11*s)), H-ftr+int(2*s))

    if round_:
        mask=Image.new("L",(W,H),0); ImageDraw.Draw(mask).ellipse([0,0,W-1,H-1],fill=255)
        bg=Image.new("RGB",(W,H),(0,0,0)); bg.paste(img,(0,0),mask); img=bg
    return img


def make_icon():
    S=25; img=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(img)
    W=(255,255,255,255); cx=cy=12
    for r in (11,7): d.ellipse([cx-r,cy-r,cx+r,cy+r],outline=W,width=2)
    d.line([cx,cy-11,cx,cy+11],fill=W,width=1); d.line([cx-11,cy,cx+11,cy],fill=W,width=1)
    a=math.radians(-45); d.line([cx,cy,cx+int(11*math.cos(a)),cy+int(11*math.sin(a))],fill=W,width=2)
    d.ellipse([cx-2,cy-2,cx+2,cy+2],fill=W); return img


def make_banner():
    B=Image.new("RGB",(720,320),(16,16,20)); bd=ImageDraw.Draw(B)
    bd.text((48,104),"WSR-88D Radar",font=f(SANSB,44),fill=(255,255,255))
    bd.text((50,168),"Live NEXRAD weather",font=f(SANS,23),fill=(178,198,208))
    bd.text((50,198),"radar on your wrist",font=f(SANS,23),fill=(178,198,208))
    bd.text((50,240),"PEBBLE TIME 2",font=f(SANSB,19),fill=(90,170,120))
    face=draw_face(200,228).resize((175,200),Image.LANCZOS)
    fr=Image.new("RGB",(191,216),(40,40,46))
    ImageDraw.Draw(fr).rounded_rectangle([0,0,190,215],radius=22,fill=(40,40,46))
    fr.paste(face,(8,8)); B.paste(fr,(505,52)); return B


if __name__ == "__main__":
    specs={"emery":(200,228,False,False),"basalt":(144,168,False,False),
           "chalk":(180,180,False,True),"diorite":(144,168,True,False)}
    for name,(W,H,mono,rnd) in specs.items():
        draw_face(W,H,mono,rnd).save(f"store/screenshot-{name}.png")
        print(f"store/screenshot-{name}.png  {W}x{H}")
    ic=make_icon(); ic.save("store/icon.png"); ic.save("resources/images/icon.png")
    print("store/icon.png + resources/images/icon.png  25x25")
    make_banner().save("store/banner.png"); print("store/banner.png  720x320")
