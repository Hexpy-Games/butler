//! Deterministic 5×7 notice lettering, independent of installed fonts.
use image::{ImageFormat, Rgb, RgbImage};
use std::io::Cursor;

const FONT: &[(char, [u8; 7])] = &[
    ('A', [14, 17, 17, 31, 17, 17, 17]),
    ('B', [30, 17, 17, 30, 17, 17, 30]),
    ('C', [14, 17, 16, 16, 16, 17, 14]),
    ('D', [30, 17, 17, 17, 17, 17, 30]),
    ('E', [31, 16, 16, 30, 16, 16, 31]),
    ('F', [31, 16, 16, 30, 16, 16, 16]),
    ('G', [14, 17, 16, 23, 17, 17, 15]),
    ('H', [17, 17, 17, 31, 17, 17, 17]),
    ('I', [31, 4, 4, 4, 4, 4, 31]),
    ('J', [7, 2, 2, 2, 18, 18, 12]),
    ('K', [17, 18, 20, 24, 20, 18, 17]),
    ('L', [16, 16, 16, 16, 16, 16, 31]),
    ('M', [17, 27, 21, 21, 17, 17, 17]),
    ('N', [17, 25, 21, 19, 17, 17, 17]),
    ('O', [14, 17, 17, 17, 17, 17, 14]),
    ('P', [30, 17, 17, 30, 16, 16, 16]),
    ('Q', [14, 17, 17, 17, 21, 18, 13]),
    ('R', [30, 17, 17, 30, 20, 18, 17]),
    ('S', [15, 16, 16, 14, 1, 1, 30]),
    ('T', [31, 4, 4, 4, 4, 4, 4]),
    ('U', [17, 17, 17, 17, 17, 17, 14]),
    ('V', [17, 17, 17, 17, 17, 10, 4]),
    ('W', [17, 17, 17, 21, 21, 21, 10]),
    ('X', [17, 17, 10, 4, 10, 17, 17]),
    ('Y', [17, 17, 10, 4, 4, 4, 4]),
    ('Z', [31, 1, 2, 4, 8, 16, 31]),
    ('0', [14, 17, 19, 21, 25, 17, 14]),
    ('1', [4, 12, 4, 4, 4, 4, 14]),
    ('2', [14, 17, 1, 2, 4, 8, 31]),
    ('3', [30, 1, 1, 14, 1, 1, 30]),
    ('4', [2, 6, 10, 18, 31, 2, 2]),
    ('5', [31, 16, 16, 30, 1, 1, 30]),
    ('6', [14, 16, 16, 30, 17, 17, 14]),
    ('7', [31, 1, 2, 4, 8, 8, 8]),
    ('8', [14, 17, 17, 14, 17, 17, 14]),
    ('9', [14, 17, 17, 15, 1, 1, 14]),
    ('$', [4, 15, 20, 14, 5, 30, 4]),
    (' ', [0; 7]),
    ('-', [0, 0, 0, 31, 0, 0, 0]),
    (':', [0, 4, 4, 0, 4, 4, 0]),
    ('/', [1, 2, 2, 4, 8, 8, 16]),
    (',', [0, 0, 0, 0, 0, 4, 8]),
    ('.', [0, 0, 0, 0, 0, 0, 4]),
];

pub(crate) fn jpeg(lines: &[&str]) -> Vec<u8> {
    let width =
        u32::try_from(lines.iter().map(|line| line.len()).max().unwrap_or(1) * 36 + 48).unwrap();
    let height = u32::try_from(lines.len() * 60 + 48).unwrap();
    let mut image = RgbImage::from_pixel(width.max(300), height.max(100), Rgb([255; 3]));
    for (line, text) in lines.iter().enumerate() {
        for (column, c) in text.chars().enumerate() {
            let rows = FONT
                .iter()
                .find(|(glyph, _)| *glyph == c.to_ascii_uppercase())
                .expect("notice font glyph")
                .1;
            for (y, row) in rows.iter().enumerate() {
                for x in 0..5 {
                    if row & (1 << (4 - x)) != 0 {
                        for dy in 0..6 {
                            for dx in 0..6 {
                                image.put_pixel(
                                    u32::try_from(24 + column * 36 + x * 6 + dx).unwrap(),
                                    u32::try_from(24 + line * 60 + y * 6 + dy).unwrap(),
                                    Rgb([0; 3]),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
    bytes.into_inner()
}

pub(crate) fn notice(url: &str) -> Option<Vec<u8>> {
    let lines: &[&str] = match url {
        "https://status.corvel.test/notices/maintenance" => &[
            "CORVEL STATUS",
            "SCHEDULED MAINTENANCE",
            "NOV 19 2026",
            "02:00-04:00 UTC",
            "API AND DASHBOARD",
            "REF QX-7731",
        ],
        "https://corvel.test/pricing" => &[
            "CORVEL PLANS",
            "FREE  10,000 REQUESTS / MONTH",
            "PRO  250,000 REQUESTS / MONTH",
            "UPDATED 2026-10-02",
        ],
        "https://lumora.test/pricing" => &[
            "Pricing",
            "Free",
            "3 projects",
            "Starter",
            "$12 per user / month",
            "Team",
            "$38 per user / month",
            "Business",
            "$74 per user / month",
            "Enterprise",
            "Contact sales",
            "Prices updated 2026-10-01",
        ],
        _ => return None,
    };
    Some(jpeg(lines))
}
