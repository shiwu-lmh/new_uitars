from __future__ import annotations

from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


BASE_URL = "http://127.0.0.1:8765"
ROOT = Path(__file__).parent
CHROME = r"C:\Users\musi\AppData\Local\Google\Chrome\Application\chrome.exe"


def login(page: Page, username: str = "demo", password: str = "demo") -> None:
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator("#username").fill(username)
    page.locator("#password").fill(password)
    page.get_by_role("button", name="登录病例工作台").click()


def test_login_error_and_success() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        login(page, password="wrong")
        expect(page.locator("#login-error")).to_have_text("演示账号或密码错误。")
        expect(page.locator("#login-panel")).to_be_visible()

        login(page)
        expect(page.locator("#app-panel")).to_be_visible()
        expect(page.locator("#result-summary")).to_contain_text("共 6 人")
        browser.close()


def test_pagination_filters_and_empty_result() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        login(page)

        expect(page.locator("#page-info")).to_have_text("1 / 2")
        expect(page.locator(".result-card")).to_have_count(3)
        page.locator("#next-page").click()
        expect(page.locator("#page-info")).to_have_text("2 / 2")
        expect(page.locator(".result-card")).to_have_count(3)

        page.locator("#search-input").fill("重复姓名患者")
        page.locator("#search-button").click()
        expect(page.locator("#result-summary")).to_have_text("共 2 人 · 每页 3 人")
        expect(page.locator(".result-card")).to_have_count(2)
        expect(page.locator("#results")).to_contain_text("DEMO-004")
        expect(page.locator("#results")).to_contain_text("DEMO-005")

        page.locator("#search-input").fill("NOT-FOUND")
        page.locator("#search-button").click()
        expect(page.locator("#results")).to_have_text("没有符合条件的演示数据。")
        expect(page.locator("#page-info")).to_have_text("0 / 1")
        browser.close()


def test_same_name_disambiguation_and_record_toggle() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        login(page)

        page.locator("#search-input").fill("DEMO-005")
        page.locator("#search-button").click()
        card = page.locator(".result-card").filter(has_text="DEMO-005")
        expect(card).to_have_count(1)
        expect(card).to_contain_text("重复姓名患者")
        expect(card).to_contain_text("1992-04-19")
        card.get_by_role("button", name="进入病历").click()

        details = page.locator("#details")
        expect(details.locator("h2")).to_contain_text("DEMO-005")
        expect(details).to_contain_text("1992-04-19")
        records = details.locator(".record-card")
        expect(records).to_have_count(1)
        expect(records.nth(0)).not_to_have_attribute("open", "")

        page.get_by_role("button", name="展开全部记录").click()
        expect(records.nth(0)).to_have_attribute("open", "")
        page.get_by_role("button", name="收起全部记录").click()
        expect(records.nth(0)).not_to_have_attribute("open", "")

        page.get_by_role("button", name="← 返回列表").first.click()
        expect(page.locator("#search-input")).to_be_visible()
        page.locator("#logout-button").click()
        expect(page.locator("#login-panel")).to_be_visible()
        browser.close()
