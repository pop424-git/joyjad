# หน้าพาทัวร์ (guide.html)

หน้าเดียวจบ ไว้ส่งให้คนจัดก๊วนดูว่าแอปใช้ยังไง — เผยแพร่ที่ https://joyjad.vercel.app/guide

ทุกภาพในหน้านี้เป็น screenshot จริงจากแอป จับด้วย headless Chrome ผ่าน CDP
ไม่ได้วาด mockup และไม่ได้แต่งภาพ

## ไฟล์

| ไฟล์ | คืออะไร |
|---|---|
| `walk-template.html` | **ต้นฉบับที่ต้องแก้** — ใช้ `{{ชื่อภาพ}}` เป็น placeholder |
| `shots.js` | จับภาพหลัก 11 ใบ (`03-pick` … `12-viewer`) |
| `shot-setup.js` | จับ `01-home` (โหมดแอดมิน เลือกคอร์ท 3+7) กับ `02-courts` (ซูมเฉพาะส่วนเลือกสนาม) |
| `shot-viewer-home.js` | จับ `00-viewer-home` (หน้าแรกฝั่งคนดู ไม่มีปุ่มจัดคิว) |
| `*.jpg` | ภาพที่จับได้ — โดน `.gitignore` ของ repo คลุมอยู่ ไม่ขึ้น repo |
| `joyjad-for-organizers.html` | ไฟล์ที่ generate แล้ว ฝังภาพเป็น data URI (สำเนาของ `guide.html`) |

สคริปต์ยิงเข้า `window.__bq` ซึ่งเป็น test hook ที่มีอยู่แล้วท้าย `index.html`
(จำเป็น เพราะโค้ดแอปทั้งหมดอยู่ใน IIFE เรียกจากข้างนอกไม่ได้)

## สร้างใหม่

เปิด dev server ก่อน

```bash
node .claude/serve.js
```

จับภาพ (คนละหน้าต่าง)

```bash
node .claude/presentation/shots.js
```

```bash
node .claude/presentation/shot-setup.js
```

```bash
node .claude/presentation/shot-viewer-home.js
```

แก้เนื้อหาที่ `walk-template.html` แล้วฝังภาพกลับเข้าไป

```bash
node -e "const f=require('fs');let h=f.readFileSync('.claude/presentation/walk-template.html','utf8');h=h.replace(/\{\{([0-9a-z-]+)\}\}/g,(m,k)=>'data:image/jpeg;base64,'+f.readFileSync('.claude/presentation/'+k+'.jpg').toString('base64'));f.writeFileSync('guide.html',h);f.writeFileSync('.claude/presentation/joyjad-for-organizers.html',h)"
```

แล้ว push ขึ้น `main` — Vercel deploy ให้เอง
