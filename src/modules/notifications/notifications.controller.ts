import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { AuthedRequest } from '../../common/auth/request-auth.js';
import { ListNotificationsQueryDto } from './dto/list-notifications.dto.js';
import { MarkReadDto } from './dto/mark-read.dto.js';
import { NotificationsService } from './notifications.service.js';

// The recipient's own notifications (Phase F2, docs/phase-f-design.md section
// 5): any active member on an active device (TenantInterceptor), never anyone
// else's. Online only; notifications are not synced.
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Req() request: AuthedRequest, @Query() query: ListNotificationsQueryDto) {
    const r = await this.notifications.list(request.session!.membership.id, query);
    return {
      notifications: r.notifications.map((n) => ({
        id: n.id,
        type: n.type,
        data: n.data,
        message: n.message,
        created_at: n.createdAt.toISOString(),
        read_at: n.readAt ? n.readAt.toISOString() : null,
      })),
      next_cursor: r.nextCursor,
    };
  }

  @Get('unread-count')
  async unreadCount(@Req() request: AuthedRequest) {
    return { unread: await this.notifications.unreadCount(request.session!.membership.id) };
  }

  // 204 always: the answer never shows which ids exist.
  @Post('read')
  @HttpCode(204)
  async markRead(@Req() request: AuthedRequest, @Body() body: MarkReadDto): Promise<void> {
    await this.notifications.markRead(request.session!.membership.id, body);
  }
}
