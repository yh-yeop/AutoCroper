"""icons/icon-512.png → build/icon.ico (16~256px, Windows 설치 파일·실행 파일 아이콘). 저장소 루트에서: python3 build/make-icon.py"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Image.open(root / "icons" / "icon-512.png").convert("RGBA")
sizes = [16, 24, 32, 48, 64, 128, 256]
src.save(root / "build" / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes],
         bitmap_format="bmp")  # BMP 항목: NSIS·rcedit 호환성이 가장 좋다
print("build/icon.ico 생성 완료:", sizes)
