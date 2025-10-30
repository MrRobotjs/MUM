from flask_openapi3 import APIBlueprint, Tag

# Public API v2 blueprint (OpenAPI-aware)
public_session_tag = Tag(name="PublicSession", description="Public authentication, session and identity")
public_invite_tag = Tag(name="PublicInvites", description="Public invite validation endpoints")
public_wizard_tag = Tag(name="PublicWizard", description="Invite wizard flow endpoints")

api_v2_public = APIBlueprint(
    name="api_v2_public",
    import_name=__name__,
)

# Ensure module sub-imports register their routes on api_v2_public
from . import session  # noqa: E402,F401
from . import invites  # noqa: E402,F401
from . import invite_wizard as wizard  # noqa: E402,F401
