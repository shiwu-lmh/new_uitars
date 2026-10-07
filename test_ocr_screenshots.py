from ocr_screenshots import merge_pages


def test_merge_pages_deduplicates_numbered_markdown_rows() -> None:
    text = "序号 | 标题 | 描述\n1 | 本地医疗系统演示 | 本地医疗系统演示\n2 | 本地医疗系统演示 | 本地医疗系统演示"

    merged = merge_pages([text])

    assert merged.count("本地医疗系统演示") == 2
    assert "1 |" in merged
    assert "2 |" not in merged
