from __future__ import annotations

from typing import Any, Optional

from app.models import UserType


def get_user_avatar_url(
    user: Optional[Any],
    *,
    discord_size: int = 256,
    prefer_animated_discord: bool = False,
) -> Optional[str]:
    if not user:
        return None

    if user.userType == UserType.OWNER:
        plex_thumb = getattr(user, "plex_thumb", None)
        if plex_thumb:
            return plex_thumb

    if user.userType in {UserType.LOCAL, UserType.OWNER}:
        discord_avatar_hash = getattr(user, "discord_avatar_hash", None)
        discord_user_id = getattr(user, "discord_user_id", None)
        if discord_avatar_hash and discord_user_id:
            extension = "gif" if prefer_animated_discord and str(discord_avatar_hash).startswith("a_") else "png"
            return f"https://cdn.discordapp.com/avatars/{discord_user_id}/{discord_avatar_hash}.{extension}?size={discord_size}"
        external_avatar_url = getattr(user, "external_avatar_url", None)
        if external_avatar_url:
            return external_avatar_url

    if user.userType == UserType.SERVICE:
        external_avatar_url = getattr(user, "external_avatar_url", None)
        if external_avatar_url:
            return external_avatar_url

        service_thumb = None
        service_settings = getattr(user, "service_settings", None)
        if service_settings:
            service_thumb = service_settings.get("thumb")

        server = getattr(user, "server", None)
        if service_thumb and server:
            base_url = server.public_url or server.url
            if service_thumb.startswith("/"):
                return f"{base_url.rstrip('/')}{service_thumb}"
            return service_thumb

    return None
