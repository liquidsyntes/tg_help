import { Module } from '@nestjs/common';
import { HtmlSanitizer } from './html-sanitizer.service';
import { TelegramRenderer } from './telegram-renderer.service';

@Module({
  providers: [HtmlSanitizer, TelegramRenderer],
  exports: [HtmlSanitizer, TelegramRenderer],
})
export class RenderingModule {}
