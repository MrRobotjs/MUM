# File: app/models_overseerr.py
from app.extensions import db
from datetime import datetime


class OverseerrUserLink(db.Model):
    """Model to store the linkage between Plex users and Overseerr users"""
    __tablename__ = 'overseerr_user_links'
    
    id = db.Column(db.Integer, primary_key=True)
    
    # Plex information
    plex_user_id = db.Column(db.String(255), nullable=False)  # Plex user ID
    plex_username = db.Column(db.String(255), nullable=False)  # Plex username
    plex_email = db.Column(db.String(255), nullable=True)  # Plex email
    
    # Overseerr information
    overseerr_user_id = db.Column(db.Integer, nullable=True)  # Overseerr user ID (can be null if not linked)
    overseerr_username = db.Column(db.String(255), nullable=True)  # Overseerr display name
    overseerr_email = db.Column(db.String(255), nullable=True)  # Overseerr email
    
    # Server relationship
    server_id = db.Column(db.Integer, db.ForeignKey('media_servers.id'), nullable=False)
    server = db.relationship('MediaServer', backref='overseerr_user_links')
    
    # Status
    is_linked = db.Column(db.Boolean, default=False, nullable=False)  # Whether user is linked to Overseerr
    last_sync_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    
    # Timestamps
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    
    def __repr__(self):
        return f'<OverseerrUserLink {self.plex_username} -> {self.overseerr_username}>'
    
    @classmethod
    def sync_users(cls, server_id: int, linked_users: list):
        """Sync the linked users data to the database"""
        try:
            # Clear existing links for this server
            cls.query.filter_by(server_id=server_id).delete()
            
            # Add new links
            for user_data in linked_users:
                link = cls(
                    plex_user_id=user_data['plex_id'],
                    plex_username=user_data['plex_username'],
                    plex_email=user_data.get('plex_email'),
                    overseerr_user_id=user_data.get('overseerr_user_id'),
                    overseerr_username=user_data.get('overseerr_username'),
                    overseerr_email=user_data.get('overseerr_email'),
                    server_id=server_id,
                    is_linked=user_data.get('is_linked', False),
                    last_sync_at=datetime.utcnow()
                )
                db.session.add(link)
            
            db.session.commit()
            return True, f"Synced {len(linked_users)} user links"
            
        except Exception as e:
            db.session.rollback()
            return False, f"Error syncing user links: {str(e)}"
    
    @classmethod
    def get_overseerr_user_id(cls, server_id: int, plex_user_id: str):
        """Get the Overseerr user ID for a given Plex user"""
        link = cls.query.filter_by(
            server_id=server_id,
            plex_user_id=plex_user_id,
            is_linked=True
        ).first()
        
        return link.overseerr_user_id if link else None
    
    @classmethod
    def link_single_user(cls, server_id: int, plex_user_id: str, plex_username: str, plex_email: str = None):
        """Attempt to link a single Plex user to Overseerr on-demand"""
        from app.services.overseerr_service_deprecated import OverseerrService
        from app.models_media_services import MediaServer
        from app.extensions import db
        from datetime import datetime
        
        try:
            # Get the server to access Overseerr
            server = MediaServer.query.get(server_id)
            if not server or not server.overseerr_enabled or not server.overseerr_url or not server.overseerr_api_key:
                return False, None, "Overseerr not properly configured for this server"
            
            # Check if user is already linked
            existing_link = cls.query.filter_by(
                server_id=server_id,
                plex_user_id=plex_user_id
            ).first()
            
            if existing_link and existing_link.is_linked:
                return True, existing_link.overseerr_user_id, "User already linked"
            
            # Try to find the user in Overseerr
            overseerr = OverseerrService(server.overseerr_url, server.overseerr_api_key)
            success, overseerr_user, message = overseerr.get_user_by_plex_username(plex_username)
            
            if not success:
                return False, None, f"Failed to check Overseerr: {message}"
            
            if not overseerr_user:
                # User not found in Overseerr - create unlinked record for future reference
                if not existing_link:
                    new_link = cls(
                        plex_user_id=plex_user_id,
                        plex_username=plex_username,
                        plex_email=plex_email,
                        overseerr_user_id=None,
                        overseerr_username=None,
                        overseerr_email=None,
                        server_id=server_id,
                        is_linked=False,
                        last_sync_at=datetime.utcnow()
                    )
                    db.session.add(new_link)
                    db.session.commit()
                return False, None, "User not found in Overseerr"
            
            # User found! Create or update the link
            overseerr_user_id = overseerr_user.get('id')
            overseerr_username = overseerr_user.get('username', overseerr_user.get('email', 'Unknown'))
            overseerr_email = overseerr_user.get('email')
            
            if existing_link:
                # Update existing record
                existing_link.overseerr_user_id = overseerr_user_id
                existing_link.overseerr_username = overseerr_username
                existing_link.overseerr_email = overseerr_email
                existing_link.is_linked = True
                existing_link.last_sync_at = datetime.utcnow()
            else:
                # Create new link
                new_link = cls(
                    plex_user_id=plex_user_id,
                    plex_username=plex_username,
                    plex_email=plex_email,
                    overseerr_user_id=overseerr_user_id,
                    overseerr_username=overseerr_username,
                    overseerr_email=overseerr_email,
                    server_id=server_id,
                    is_linked=True,
                    last_sync_at=datetime.utcnow()
                )
                db.session.add(new_link)
            
            db.session.commit()
            return True, overseerr_user_id, f"Successfully linked to Overseerr user: {overseerr_username}"
            
        except Exception as e:
            db.session.rollback()
            return False, None, f"Error linking user: {str(e)}"
