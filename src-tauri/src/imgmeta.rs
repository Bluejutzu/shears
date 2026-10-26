//! Reading and writing tags in PNG and JPEG files, using the same tag names as video files.
//!
//! PNG keeps them as text chunks. JPEG keeps them as an XMP packet (the usual ones as
//! dc:/xmp: fields other apps understand, the rest in a list of our own).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetaEdit {
    #[serde(default)]
    strip: bool,
    #[serde(default)]
    tags: Vec<(String, Option<String>)>,
}

type Tags = BTreeMap<String, String>;

const PNG_SIG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const PNG_NAMES: &[(&str, &str)] = &[
    ("title", "Title"),
    ("artist", "Author"),
    ("description", "Description"),
    ("copyright", "Copyright"),
    ("creation_time", "Creation Time"),
    ("software", "Software"),
    ("comment", "Comment"),
];
const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for part in parts {
        for &b in *part {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
    }
    !c
}

fn apply(mut tags: Tags, edit: &MetaEdit) -> Tags {
    if edit.strip {
        return Tags::new();
    }
    for (k, v) in &edit.tags {
        match v.as_deref().map(str::trim) {
            Some(v) if !v.is_empty() => tags.insert(k.clone(), v.to_string()),
            _ => tags.remove(k),
        };
    }
    tags
}

// ---- PNG

struct Chunk<'a> {
    kind: [u8; 4],
    data: &'a [u8],
}

fn png_chunks(b: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    if !b.starts_with(PNG_SIG) {
        return Err("not a PNG file".into());
    }
    let mut out = Vec::new();
    let mut i = PNG_SIG.len();
    while i + 12 <= b.len() {
        let len = u32::from_be_bytes(b[i..i + 4].try_into().unwrap()) as usize;
        if i + 12 + len > b.len() {
            return Err("damaged PNG".into());
        }
        out.push(Chunk { kind: b[i + 4..i + 8].try_into().unwrap(), data: &b[i + 8..i + 8 + len] });
        i += 12 + len;
    }
    Ok(out)
}

fn is_text(kind: &[u8; 4]) -> bool {
    matches!(kind, b"tEXt" | b"iTXt" | b"zTXt")
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

fn png_read(b: &[u8]) -> Result<Tags, String> {
    let mut tags = Tags::new();
    for c in png_chunks(b)? {
        let Some(z) = c.data.iter().position(|&x| x == 0) else { continue };
        let key = latin1(&c.data[..z]);
        let rest = &c.data[z + 1..];
        let value = match &c.kind {
            b"tEXt" => latin1(rest),
            // flag, method, language\0, translated keyword\0, text (skipped when compressed)
            b"iTXt" if rest.first() == Some(&0) && rest.len() > 2 => {
                let after = &rest[2..];
                let Some(a) = after.iter().position(|&x| x == 0) else { continue };
                let Some(t) = after[a + 1..].iter().position(|&x| x == 0) else { continue };
                String::from_utf8_lossy(&after[a + 1 + t + 1..]).into_owned()
            }
            _ => continue,
        };
        if key == "XML:com.adobe.xmp" {
            continue;
        }
        let name = PNG_NAMES.iter().find(|(_, k)| k.eq_ignore_ascii_case(&key)).map_or(key, |(n, _)| n.to_string());
        tags.insert(name, value);
    }
    Ok(tags)
}

fn png_chunk(kind: &[u8; 4], data: &[u8], out: &mut Vec<u8>) {
    out.extend((data.len() as u32).to_be_bytes());
    out.extend(kind);
    out.extend(data);
    out.extend(crc32(&[kind, data]).to_be_bytes());
}

fn png_write(b: &[u8], edit: &MetaEdit) -> Result<Vec<u8>, String> {
    let chunks = png_chunks(b)?;
    let tags = apply(png_read(b)?, edit);
    let mut out = PNG_SIG.to_vec();
    for (n, c) in chunks.iter().enumerate() {
        if is_text(&c.kind) || (edit.strip && &c.kind == b"eXIf") {
            continue;
        }
        png_chunk(&c.kind, c.data, &mut out);
        if n == 0 {
            for (k, v) in &tags {
                let key = PNG_NAMES.iter().find(|(n, _)| n == k).map_or(k.as_str(), |(_, p)| p);
                let valid = (1..=79).contains(&key.chars().count()) && key.chars().all(|c| (' '..='~').contains(&c));
                if !valid {
                    continue;
                }
                if v.chars().all(|c| (c as u32) < 256) {
                    let mut d = key.as_bytes().to_vec();
                    d.push(0);
                    d.extend(v.chars().map(|c| c as u8));
                    png_chunk(b"tEXt", &d, &mut out);
                } else {
                    let mut d = key.as_bytes().to_vec();
                    d.extend([0, 0, 0, 0, 0]);
                    d.extend(v.as_bytes());
                    png_chunk(b"iTXt", &d, &mut out);
                }
            }
        }
    }
    Ok(out)
}

// ---- JPEG

/// Splits a JPEG into its header segments and the picture data that starts at the scan.
type Segments<'a> = Vec<(u8, &'a [u8])>;

fn jpeg_segments(b: &[u8]) -> Result<(Segments<'_>, &[u8]), String> {
    if !b.starts_with(&[0xFF, 0xD8]) {
        return Err("not a JPEG file".into());
    }
    let mut segs = Vec::new();
    let mut i = 2;
    while i + 4 <= b.len() && b[i] == 0xFF {
        let marker = b[i + 1];
        if marker == 0xDA {
            break;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            return Err("damaged JPEG".into());
        }
        segs.push((marker, &b[i + 4..i + 2 + len]));
        i += 2 + len;
    }
    Ok((segs, &b[i..]))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The text of the first <tag>...</tag> in xml.
fn element<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}");
    let mut from = 0;
    loop {
        let start = from + xml[from..].find(&open)?;
        let after = start + open.len();
        match xml[after..].chars().next()? {
            '>' | ' ' | '/' => {
                let body = after + xml[after..].find('>')? + 1;
                let end = body + xml[body..].find(&format!("</{tag}>"))?;
                return Some(&xml[body..end]);
            }
            _ => from = after,
        }
    }
}

fn list_items(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(s) = rest.find("<rdf:li") {
        let Some(g) = rest[s..].find('>') else { break };
        let body = s + g + 1;
        let Some(e) = rest[body..].find("</rdf:li>") else { break };
        out.push(xml_unescape(&rest[body..body + e]));
        rest = &rest[body + e + 9..];
    }
    out
}

fn xmp_read(xml: &str) -> Tags {
    let mut tags = Tags::new();
    let mut put = |k: &str, v: Option<String>| {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            tags.insert(k.into(), v);
        }
    };
    let first = |tag: &str| element(xml, tag).and_then(|e| list_items(e).into_iter().next());
    put("title", first("dc:title"));
    put("artist", first("dc:creator"));
    put("description", first("dc:description"));
    put("copyright", first("dc:rights"));
    put("keywords", element(xml, "dc:subject").map(|e| list_items(e).join(", ")));
    put("creation_time", element(xml, "xmp:CreateDate").map(xml_unescape));
    put("software", element(xml, "xmp:CreatorTool").map(xml_unescape));
    if let Some(bag) = element(xml, "shears:tags") {
        let mut rest = bag;
        while let (Some(k), Some(v)) = (element(rest, "shears:k"), element(rest, "shears:v")) {
            let end = rest.find("</shears:v>").unwrap_or(rest.len()) + 11;
            put(&xml_unescape(k), Some(xml_unescape(v)));
            rest = &rest[end.min(rest.len())..];
        }
    }
    tags
}

fn xmp_write(tags: &Tags) -> String {
    let mut x = String::from(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:shears=\"https://github.com/Bluejutzu/shears/ns/1.0/\">",
    );
    let known = ["title", "artist", "description", "copyright", "keywords", "creation_time", "software"];
    let list = |kind: &str, items: &[String]| {
        let li: String = items.iter().map(|i| format!("<rdf:li>{}</rdf:li>", xml_escape(i))).collect();
        format!("<rdf:{kind}>{li}</rdf:{kind}>")
    };
    let single = |k: &str| tags.get(k).map(|v| vec![v.clone()]);
    for (key, field, kind) in [
        ("title", "dc:title", "Alt"),
        ("artist", "dc:creator", "Seq"),
        ("description", "dc:description", "Alt"),
        ("copyright", "dc:rights", "Alt"),
    ] {
        if let Some(v) = single(key) {
            x += &format!("<{field}>{}</{field}>", list(kind, &v));
        }
    }
    if let Some(k) = tags.get("keywords") {
        let items: Vec<String> = k.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        x += &format!("<dc:subject>{}</dc:subject>", list("Bag", &items));
    }
    if let Some(v) = tags.get("creation_time") {
        x += &format!("<xmp:CreateDate>{}</xmp:CreateDate>", xml_escape(v));
    }
    if let Some(v) = tags.get("software") {
        x += &format!("<xmp:CreatorTool>{}</xmp:CreatorTool>", xml_escape(v));
    }
    let own: Vec<_> = tags.iter().filter(|(k, _)| !known.contains(&k.as_str())).collect();
    if !own.is_empty() {
        x += "<shears:tags><rdf:Bag>";
        for (k, v) in own {
            x += &format!(
                "<rdf:li rdf:parseType=\"Resource\"><shears:k>{}</shears:k><shears:v>{}</shears:v></rdf:li>",
                xml_escape(k),
                xml_escape(v)
            );
        }
        x += "</rdf:Bag></shears:tags>";
    }
    x + "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
}

fn jpeg_read(b: &[u8]) -> Result<Tags, String> {
    let (segs, _) = jpeg_segments(b)?;
    let mut tags = Tags::new();
    for (marker, data) in segs {
        if marker == 0xE1 && data.starts_with(XMP_NS) {
            tags.extend(xmp_read(&String::from_utf8_lossy(&data[XMP_NS.len()..])));
        } else if marker == 0xFE && !tags.contains_key("comment") {
            tags.insert("comment".into(), String::from_utf8_lossy(data).trim().to_string());
        }
    }
    Ok(tags)
}

fn jpeg_write(b: &[u8], edit: &MetaEdit) -> Result<Vec<u8>, String> {
    let (segs, scan) = jpeg_segments(b)?;
    let tags = apply(jpeg_read(b)?, edit);
    let mut out = vec![0xFF, 0xD8];
    let put = |marker: u8, data: &[u8], out: &mut Vec<u8>| {
        out.extend([0xFF, marker]);
        out.extend(((data.len() + 2) as u16).to_be_bytes());
        out.extend(data);
    };
    let packet = || {
        let mut d = XMP_NS.to_vec();
        d.extend(xmp_write(&tags).as_bytes());
        d
    };
    let mut written = tags.is_empty();
    for (marker, data) in segs {
        // our packet goes in once the leading APPn segments are done
        if !written && !(0xE0..=0xEF).contains(&marker) {
            put(0xE1, &packet(), &mut out);
            written = true;
        }
        let ours = marker == 0xE1 && data.starts_with(XMP_NS);
        let private = matches!(marker, 0xE1 | 0xED | 0xFE);
        if ours || marker == 0xFE || (edit.strip && private) {
            continue;
        }
        put(marker, data, &mut out);
    }
    if !written {
        put(0xE1, &packet(), &mut out);
    }
    out.extend(scan);
    Ok(out)
}

// ---- commands

fn read_any(b: &[u8]) -> Result<Tags, String> {
    if b.starts_with(PNG_SIG) {
        png_read(b)
    } else if b.starts_with(&[0xFF, 0xD8]) {
        jpeg_read(b)
    } else {
        Ok(Tags::new())
    }
}

/// Tags written in a PNG or JPEG; other kinds of picture just have none.
#[tauri::command]
pub fn image_tags_read(path: String) -> Result<Tags, String> {
    read_any(&std::fs::read(path).map_err(|e| e.to_string())?)
}

/// Rewrites the file with the edited tags. PNG and JPEG only: other kinds can't hold them.
#[tauri::command]
pub fn image_tags_write(path: String, edit: MetaEdit) -> Result<(), String> {
    let file = PathBuf::from(&path);
    let b = std::fs::read(&file).map_err(|e| e.to_string())?;
    let out = if b.starts_with(PNG_SIG) {
        png_write(&b, &edit)?
    } else if b.starts_with(&[0xFF, 0xD8]) {
        jpeg_write(&b, &edit)?
    } else {
        return Err("Only PNG and JPEG pictures can hold metadata".into());
    };
    let tmp = file.with_extension("shears-tmp");
    std::fs::write(&tmp, out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(tags: &[(&str, Option<&str>)]) -> MetaEdit {
        MetaEdit { strip: false, tags: tags.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect() }
    }

    fn tiny_png() -> Vec<u8> {
        let mut b = PNG_SIG.to_vec();
        png_chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0], &mut b);
        png_chunk(b"IDAT", &[1, 2, 3], &mut b);
        png_chunk(b"IEND", &[], &mut b);
        b
    }

    fn tiny_jpeg() -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 4, b'J', b'F', 0xFF, 0xDA, 0, 4, 1, 2, 0xFF, 0xD9]
    }

    #[test]
    fn png_round_trip() {
        let b = png_write(&tiny_png(), &edit(&[("title", Some("Hi")), ("artist", Some("Zoë")), ("mood", Some("calm"))])).unwrap();
        let t = png_read(&b).unwrap();
        assert_eq!(t["title"], "Hi");
        assert_eq!(t["artist"], "Zoë");
        assert_eq!(t["mood"], "calm");
        let b = png_write(&b, &edit(&[("title", None)])).unwrap();
        assert!(!png_read(&b).unwrap().contains_key("title"));
        let b = png_write(&b, &MetaEdit { strip: true, tags: vec![] }).unwrap();
        assert!(png_read(&b).unwrap().is_empty());
        assert!(b.windows(4).any(|w| w == b"IDAT"));
    }

    #[test]
    fn jpeg_round_trip() {
        let b = jpeg_write(&tiny_jpeg(), &edit(&[("title", Some("A & B")), ("keywords", Some("x, y")), ("mood", Some("calm"))])).unwrap();
        let t = jpeg_read(&b).unwrap();
        assert_eq!(t["title"], "A & B");
        assert_eq!(t["keywords"], "x, y");
        assert_eq!(t["mood"], "calm");
        let b = jpeg_write(&b, &MetaEdit { strip: true, tags: vec![] }).unwrap();
        assert!(jpeg_read(&b).unwrap().is_empty());
        assert!(b.ends_with(&[0xFF, 0xD9]));
    }
}
