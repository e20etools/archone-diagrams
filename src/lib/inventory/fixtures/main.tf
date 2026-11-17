# A small web stack on AWS.
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "shop-vpc" }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
  tags = {
    Name = "app-subnet"
  }
}

resource "aws_security_group" "web" {
  name   = "web-sg"
  vpc_id = aws_vpc.main.id
}

resource "aws_lb" "public" {
  name            = "shop-alb"
  subnets         = [aws_subnet.app.id]
  security_groups = [aws_security_group.web.id]
}

resource "aws_lb_target_group" "web" {
  name   = "web-tg"
  vpc_id = aws_vpc.main.id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  default_action {
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_instance" "web" {
  instance_type          = "t3.small"
  subnet_id              = aws_subnet.app.id
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data = <<-EOT
    #!/bin/bash
    echo "{ not a brace that counts"
  EOT
  tags = { Name = "web-1" }
}

resource "aws_lb_target_group_attachment" "web" {
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.web.id
}

resource "aws_db_instance" "orders" {
  identifier     = "orders-db"
  engine         = "postgres"
  db_subnet_group_name = "default"
  vpc_security_group_ids = [aws_security_group.web.id]
}

resource "aws_s3_bucket" "assets" {
  bucket = "shop-assets"
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
}

data "aws_ami" "linux" {
  most_recent = true
}

module "monitoring" {
  source = "./modules/monitoring"
  instance_id = aws_instance.web.id
}
